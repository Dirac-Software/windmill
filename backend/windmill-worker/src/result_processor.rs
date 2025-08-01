#[cfg(feature = "otel")]
use opentelemetry::trace::FutureExt;

use serde::{Deserialize, Serialize};
use sqlx::types::Json;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU16, Ordering},
        Arc,
    },
};
use tracing::{field, Instrument};
#[cfg(not(feature = "otel"))]
use windmill_common::otel_oss::FutureExt;

use uuid::Uuid;

use windmill_common::{
    add_time,
    error::{self, Error},
    jobs::JobKind,
    utils::WarnAfterExt,
    worker::{to_raw_value, Connection, WORKER_GROUP},
    KillpillSender, DB,
};

#[cfg(feature = "benchmark")]
use windmill_common::bench::{BenchmarkInfo, BenchmarkIter};

use windmill_queue::{
    append_logs, get_queued_job, CanceledBy, JobCompleted, MiniPulledJob, WrappedError,
    INIT_SCRIPT_TAG,
};

use serde_json::{json, value::RawValue, Value};

use tokio::{sync::Notify, task::JoinHandle};

use windmill_queue::{add_completed_job, add_completed_job_error};

use crate::{
    bash_executor::ANSI_ESCAPE_RE,
    common::{error_to_value, read_result, save_in_cache},
    otel_oss::add_root_flow_job_to_otlp,
    worker_flow::update_flow_status_after_job_completion,
    JobCompletedReceiver, JobCompletedSender, SameWorkerSender, SendResult, SendResultPayload,
    UpdateFlow, SAME_WORKER_REQUIREMENTS,
};
use windmill_common::client::AuthedClient;

#[derive(Debug, Deserialize)]
struct ErrorMessage {
    message: String,
    name: String,
}

async fn process_jc(
    jc: JobCompleted,
    worker_name: &str,
    base_internal_url: &str,
    db: &DB,
    worker_dir: &str,
    same_worker_tx: Option<&SameWorkerSender>,
    job_completed_sender: &JobCompletedSender,
    #[cfg(feature = "benchmark")] bench: &mut BenchmarkIter,
) {
    let success: bool = jc.success;

    let span = if success {
        tracing::span!(
            tracing::Level::INFO,
            "job_postprocessing",
            job_id = %jc.job.id, root_job = field::Empty, workspace_id = %jc.job.workspace_id,  worker = %worker_name,tag = %jc.job.tag,
            // hostname = %hostname,
            language = field::Empty,
            script_path = field::Empty,
            flow_step_id = field::Empty,
            parent_job = field::Empty,
            otel.name = field::Empty,
            success = %success,
        )
    } else {
        tracing::span!(
            tracing::Level::INFO,
            "job_postprocessing",
            job_id = %jc.job.id, root_job = field::Empty, workspace_id = %jc.job.workspace_id,  worker = %worker_name,tag = %jc.job.tag,
            // hostname = %hostname,
            language = field::Empty,
            script_path = field::Empty,
            flow_step_id = field::Empty,
            parent_job = field::Empty,
            otel.name = field::Empty,
            success = %success,
            error.message = field::Empty,
            error.name = field::Empty,
        )
    };
    let rj = if let Some(root_job) = jc.job.flow_innermost_root_job {
        root_job
    } else {
        jc.job.id
    };
    windmill_common::otel_oss::set_span_parent(&span, &rj);

    if let Some(lg) = jc.job.script_lang.as_ref() {
        span.record("language", lg.as_str());
    }
    if let Some(step_id) = jc.job.flow_step_id.as_ref() {
        span.record(
            "otel.name",
            format!("job_postprocessing {}", step_id).as_str(),
        );
        span.record("flow_step_id", step_id.as_str());
    } else {
        span.record("otel.name", "job postprocessing");
    }
    if let Some(parent_job) = jc.job.parent_job.as_ref() {
        span.record("parent_job", parent_job.to_string().as_str());
    }
    if let Some(script_path) = jc.job.runnable_path.as_ref() {
        span.record("script_path", script_path.as_str());
    }
    if let Some(root_job) = jc.job.flow_innermost_root_job.as_ref() {
        span.record("root_job", root_job.to_string().as_str());
    }
    if !success {
        if let Ok(result_error) = serde_json::from_str::<ErrorMessage>(jc.result.get()) {
            span.record("error.message", result_error.message.as_str());
            span.record("error.name", result_error.name.as_str());
        }
    }

    let root_job = handle_receive_completed_job(
        jc,
        &base_internal_url,
        &db,
        worker_dir,
        same_worker_tx,
        &worker_name,
        job_completed_sender.clone(),
        #[cfg(feature = "benchmark")]
        bench,
    )
    .instrument(span)
    .await;

    if let Some(root_job) = root_job {
        add_root_flow_job_to_otlp(&root_job, success);
    }
}

enum JobCompletedRx {
    JobCompleted(SendResult),
    Killpill,
    WakeUp,
}

pub fn start_background_processor(
    job_completed_rx: JobCompletedReceiver,
    job_completed_sender: JobCompletedSender,
    same_worker_queue_size: Arc<AtomicU16>,
    job_completed_processor_is_done: Arc<AtomicBool>,
    wake_up_notify: Arc<Notify>,
    last_processing_duration: Arc<AtomicU16>,
    base_internal_url: String,
    db: DB,
    worker_dir: String,
    same_worker_tx: SameWorkerSender,
    worker_name: String,
    killpill_tx: KillpillSender,
    is_dedicated_worker: bool,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut has_been_killed = false;

        let JobCompletedReceiver { bounded_rx, mut killpill_rx, unbounded_rx } = job_completed_rx;

        #[cfg(feature = "benchmark")]
        let mut infos = BenchmarkInfo::new();

        //if we have been killed, we want to drain the queue of jobs
        while let Some(sr) = {
            if has_been_killed {
                tracing::info!("bg processor is killed, draining. same_worker_queue_size: {}, unbounded_rx: {}, bounded_rx: {}", same_worker_queue_size.load(Ordering::SeqCst), unbounded_rx.len(), bounded_rx.len())
            }
            if has_been_killed && same_worker_queue_size.load(Ordering::SeqCst) == 0 {
                unbounded_rx
                    .try_recv()
                    .ok()
                    .map(JobCompletedRx::JobCompleted)
                    .or_else(|| bounded_rx.try_recv().ok().map(JobCompletedRx::JobCompleted))
            } else {
                tokio::select! {
                    biased;
                    result = unbounded_rx.recv_async()  => {
                        result.ok().map(JobCompletedRx::JobCompleted)
                    }
                    result = bounded_rx.recv_async() => {
                        result.ok().map(JobCompletedRx::JobCompleted)
                    },
                    _ = wake_up_notify.notified() => {
                        tracing::info!("bg processor received wake up signal, checking if same worker queue is empty");
                        Some(JobCompletedRx::WakeUp)
                    },
                    _ = killpill_rx.recv() => {
                        tracing::info!("bg processor received killpill signal, queuing killpill job");
                        Some(JobCompletedRx::Killpill)
                    }
                }
            }
        } {
            #[cfg(feature = "benchmark")]
            let mut bench = BenchmarkIter::new();

            match sr {
                JobCompletedRx::JobCompleted(SendResult {
                    result: SendResultPayload::JobCompleted(jc),
                    time,
                }) => {
                    let is_init_script_and_failure =
                        !jc.success && jc.job.tag.as_str() == INIT_SCRIPT_TAG;
                    let is_dependency_job = matches!(
                        jc.job.kind,
                        JobKind::Dependencies | JobKind::FlowDependencies
                    );

                    process_jc(
                        jc,
                        &worker_name,
                        &base_internal_url,
                        &db,
                        &worker_dir,
                        Some(&same_worker_tx),
                        &job_completed_sender,
                        #[cfg(feature = "benchmark")]
                        &mut bench,
                    )
                    .await;

                    if is_init_script_and_failure {
                        tracing::error!("init script errored, exiting");
                        killpill_tx.send();
                        break;
                    }
                    if is_dependency_job && is_dedicated_worker {
                        tracing::error!("Dedicated worker executed a dependency job, a new script has been deployed. Exiting expecting to be restarted.");
                        sqlx::query!(
                                "UPDATE config SET config = config WHERE name = $1",
                                format!("worker__{}", *WORKER_GROUP)
                            )
                            .execute(&db)
                            .await
                            .expect("update config to trigger restart of all dedicated workers at that config");
                        killpill_tx.send();
                    }
                    add_time!(bench, "job completed processed");

                    #[cfg(feature = "benchmark")]
                    {
                        infos.add_iter(bench, true);
                    }
                    last_processing_duration
                        .store(time.elapsed().as_secs() as u16, Ordering::SeqCst);
                }
                JobCompletedRx::JobCompleted(SendResult {
                    result:
                        SendResultPayload::UpdateFlow(UpdateFlow {
                            flow,
                            w_id,
                            success,
                            result,
                            worker_dir,
                            stop_early_override,
                            token,
                        }),
                    time,
                }) => {
                    // let r;
                    tracing::info!(parent_flow = %flow, "updating flow status after job completion");
                    if let Err(e) = update_flow_status_after_job_completion(
                        &db,
                        &AuthedClient::new(
                            base_internal_url.to_string(),
                            w_id.clone(),
                            token.clone(),
                            None,
                        ),
                        flow,
                        &Uuid::nil(),
                        &w_id,
                        success,
                        Arc::new(result),
                        true,
                        &same_worker_tx,
                        &worker_dir,
                        stop_early_override,
                        &worker_name,
                        job_completed_sender.clone(),
                        #[cfg(feature = "benchmark")]
                        &mut bench,
                    )
                    .await
                    {
                        tracing::error!("Error updating flow status after job completion for {flow} on {worker_name}: {e:#}");
                    }
                    last_processing_duration
                        .store(time.elapsed().as_secs() as u16, Ordering::SeqCst);
                }
                JobCompletedRx::Killpill => {
                    tracing::info!("killpill job received, processing only same worker jobs");
                    has_been_killed = true;
                }
                JobCompletedRx::WakeUp => {}
            }
        }

        job_completed_processor_is_done.store(true, Ordering::SeqCst);

        tracing::info!("finished processing all completed jobs");

        #[cfg(feature = "benchmark")]
        {
            infos
                .write_to_file("profiling_result_processor.json")
                .expect("write to file profiling");
        }
    })
}

async fn send_job_completed(job_completed_tx: JobCompletedSender, jc: JobCompleted) {
    job_completed_tx
        .send_job(jc, true)
        .with_context(windmill_common::otel_oss::otel_ctx())
        .await
        .expect("send job completed")
}

pub async fn process_result(
    job: Arc<MiniPulledJob>,
    result: error::Result<Arc<Box<RawValue>>>,
    job_dir: &str,
    job_completed_tx: JobCompletedSender,
    mem_peak: i32,
    canceled_by: Option<CanceledBy>,
    cached_res_path: Option<String>,
    token: &str,
    result_columns: Option<Vec<String>>,
    preprocessed_args: Option<HashMap<String, Box<RawValue>>>,
    conn: &Connection,
    duration: Option<i64>,
) -> error::Result<bool> {
    match result {
        Ok(result) => {
            send_job_completed(
                job_completed_tx,
                JobCompleted {
                    job,
                    preprocessed_args,
                    result,
                    result_columns,
                    mem_peak,
                    canceled_by,
                    success: true,
                    cached_res_path,
                    token: token.to_string(),
                    duration,
                },
            )
            .with_context(windmill_common::otel_oss::otel_ctx())
            .await;
            Ok(true)
        }
        Err(e) => {
            let error_value = match e {
                Error::ExitStatus(program, i) => {
                    let res = read_result(job_dir).await.ok();

                    if res.as_ref().is_some_and(|x| !x.get().is_empty()) {
                        res.unwrap()
                    } else {
                        match conn {
                            Connection::Sql(db) => {
                                let last_10_log_lines = sqlx::query_scalar!(
                            "SELECT right(logs, 600) FROM job_logs WHERE job_id = $1 AND workspace_id = $2 ORDER BY created_at DESC LIMIT 1",
                            &job.id,
                            &job.workspace_id
                        ).fetch_one(db).await.ok().flatten().unwrap_or("".to_string());

                                let log_lines = last_10_log_lines
                                    .split("CODE EXECUTION ---")
                                    .last()
                                    .unwrap_or(&last_10_log_lines);

                                extract_error_value(
                                    &program,
                                    log_lines,
                                    i,
                                    job.flow_step_id.clone(),
                                )
                            }
                            Connection::Http(_) => {
                                to_raw_value(&"See logs for more details".to_string())
                            }
                        }
                    }
                }
                Error::ExecutionRawError(e) => to_raw_value(&e),
                err @ _ => to_raw_value(&SerializedError {
                    message: format!("execution error:\n{err:#}",),
                    name: "ExecutionErr".to_string(),
                    step_id: job.flow_step_id.clone(),
                    exit_code: None,
                }),
            };

            send_job_completed(
                job_completed_tx,
                JobCompleted {
                    job,
                    result: Arc::new(to_raw_value(&error_value)),
                    result_columns: None,
                    preprocessed_args: None,
                    mem_peak,
                    canceled_by,
                    success: false,
                    cached_res_path,
                    token: token.to_string(),
                    duration,
                },
            )
            .with_context(windmill_common::otel_oss::otel_ctx())
            .await;
            Ok(false)
        }
    }
}

pub async fn handle_receive_completed_job(
    jc: JobCompleted,
    base_internal_url: &str,
    db: &DB,
    worker_dir: &str,
    same_worker_tx: Option<&SameWorkerSender>,
    worker_name: &str,
    job_completed_tx: JobCompletedSender,
    #[cfg(feature = "benchmark")] bench: &mut BenchmarkIter,
) -> Option<Arc<MiniPulledJob>> {
    let token = jc.token.clone();
    let workspace = jc.job.workspace_id.clone();
    let client = AuthedClient::new(base_internal_url.to_string(), workspace, token, None);
    let job = jc.job.clone();
    let mem_peak = jc.mem_peak.clone();
    let canceled_by = jc.canceled_by.clone();

    let processed_completed_job = process_completed_job(
        jc,
        &client,
        db,
        &worker_dir,
        same_worker_tx.clone(),
        worker_name,
        job_completed_tx.clone(),
        #[cfg(feature = "benchmark")]
        bench,
    )
    .await;

    match processed_completed_job {
        Err(err) => {
            handle_job_error(
                db,
                &client,
                job.as_ref(),
                mem_peak,
                canceled_by,
                err,
                false,
                same_worker_tx.clone(),
                &worker_dir,
                worker_name,
                job_completed_tx,
                #[cfg(feature = "benchmark")]
                bench,
            )
            .await;
            None
        }
        Ok(r) => r,
    }
}

pub async fn process_completed_job(
    JobCompleted {
        job,
        result,
        mem_peak,
        success,
        cached_res_path,
        canceled_by,
        duration,
        result_columns,
        preprocessed_args,
        ..
    }: JobCompleted,
    client: &AuthedClient,
    db: &DB,
    worker_dir: &str,
    same_worker_tx: Option<&SameWorkerSender>,
    worker_name: &str,
    job_completed_tx: JobCompletedSender,
    #[cfg(feature = "benchmark")] bench: &mut BenchmarkIter,
) -> error::Result<Option<Arc<MiniPulledJob>>> {
    if success {
        // println!("bef completed job{:?}",  SystemTime::now());
        if let Some(cached_path) = cached_res_path {
            save_in_cache(db, client, &job, cached_path, result.clone()).await;
        }

        let is_flow_step = job.is_flow_step();
        let parent_job = job.parent_job.clone();
        let job_id = job.id.clone();
        let workspace_id = job.workspace_id.clone();

        if job.flow_step_id.as_deref() == Some("preprocessor") {
            // Do this before inserting to `v2_job_completed` for backwards compatibility
            // when we set `flow_status->_metadata->preprocessed_args` to true.

            sqlx::query!(
                r#"UPDATE v2_job SET
                    args = '{"reason":"PREPROCESSOR_ARGS_ARE_DISCARDED"}'::jsonb,
                    preprocessed = TRUE
                WHERE id = $1 AND preprocessed = FALSE"#,
                job.id
            )
            .execute(db)
            .await
            .map_err(|e| {
                Error::InternalErr(format!(
                    "error while deleting args of preprocessing step: {e:#}"
                ))
            })?;
        } else if let Some(preprocessed_args) = preprocessed_args {
            // Update script args to preprocessed args
            sqlx::query!(
                "UPDATE v2_job SET args = $1, preprocessed = TRUE WHERE id = $2",
                Json(preprocessed_args) as Json<HashMap<String, Box<RawValue>>>,
                job.id
            )
            .execute(db)
            .await?;
        }

        add_time!(bench, "pre add_completed_job");

        add_completed_job(
            db,
            &job,
            true,
            false,
            Json(&result),
            result_columns,
            mem_peak.to_owned(),
            canceled_by,
            false,
            duration,
        )
        .await?;
        drop(job);

        add_time!(bench, "add_completed_job END");

        if is_flow_step {
            if let Some(parent_job) = parent_job {
                // tracing::info!(parent_flow = %parent_job, subflow = %job_id, "updating flow status (2)");
                let r = update_flow_status_after_job_completion(
                    db,
                    client,
                    parent_job,
                    &job_id,
                    &workspace_id,
                    true,
                    result,
                    false,
                    &same_worker_tx.expect(SAME_WORKER_REQUIREMENTS).to_owned(),
                    &worker_dir,
                    None,
                    worker_name,
                    job_completed_tx,
                    #[cfg(feature = "benchmark")]
                    bench,
                )
                .warn_after_seconds(10)
                .await?;
                add_time!(bench, "updated flow status END");
                return Ok(r);
            }
        }
    } else {
        let result = add_completed_job_error(
            db,
            &job,
            mem_peak.to_owned(),
            canceled_by,
            serde_json::from_str(result.get()).unwrap_or_else(
                |_| json!({ "message": format!("Non serializable error: {}", result.get()) }),
            ),
            worker_name,
            false,
            None,
        )
        .await?;
        if job.is_flow_step() {
            if let Some(parent_job) = job.parent_job {
                tracing::error!(parent_flow = %parent_job, subflow = %job.id, "process completed job error, updating flow status");
                let r = update_flow_status_after_job_completion(
                    db,
                    client,
                    parent_job,
                    &job.id,
                    &job.workspace_id,
                    false,
                    Arc::new(serde_json::value::to_raw_value(&result).unwrap()),
                    false,
                    &same_worker_tx.expect(SAME_WORKER_REQUIREMENTS).to_owned(),
                    &worker_dir,
                    None,
                    worker_name,
                    job_completed_tx,
                    #[cfg(feature = "benchmark")]
                    bench,
                )
                .warn_after_seconds(10)
                .await?;
                return Ok(r);
            }
        }
    }
    return Ok(None);
}

async fn handle_non_flow_job_error(
    db: &DB,
    job: &MiniPulledJob,
    mem_peak: i32,
    canceled_by: Option<CanceledBy>,
    err: Value,
    worker_name: &str,
) -> Result<WrappedError, Error> {
    append_logs(
        &job.id,
        &job.workspace_id,
        format!("Unexpected error during job execution:\n{err:#?}"),
        &db.into(),
    )
    .await;
    add_completed_job_error(
        db,
        job,
        mem_peak,
        canceled_by,
        err,
        worker_name,
        false,
        None,
    )
    .await
}

#[tracing::instrument(name = "job_error", level = "info", skip_all, fields(job_id = %job.id))]
pub async fn handle_job_error(
    db: &DB,
    client: &AuthedClient,
    job: &MiniPulledJob,
    mem_peak: i32,
    canceled_by: Option<CanceledBy>,
    err: Error,
    unrecoverable: bool,
    same_worker_tx: Option<&SameWorkerSender>,
    worker_dir: &str,
    worker_name: &str,
    job_completed_tx: JobCompletedSender,
    #[cfg(feature = "benchmark")] bench: &mut BenchmarkIter,
) {
    let err = error_to_value(err);

    let update_job_future = || async {
        handle_non_flow_job_error(
            db,
            job,
            mem_peak,
            canceled_by.clone(),
            err.clone(),
            worker_name,
        )
        .await
    };

    let update_job_future = if job.is_flow_step() || job.is_flow() {
        let (flow, job_status_to_update) = if let Some(parent_job_id) = job.parent_job {
            if let Err(e) = update_job_future().await {
                tracing::error!(
                    "error updating job future for job {} for handle_job_error: {e:#}",
                    job.id
                );
            }
            (parent_job_id, job.id)
        } else {
            (job.id, Uuid::nil())
        };

        let wrapped_error = WrappedError { error: err.clone() };
        tracing::error!(parent_flow = %flow, subflow = %job_status_to_update, "handle job error, updating flow status: {err:?}");
        let updated_flow = update_flow_status_after_job_completion(
            db,
            client,
            flow,
            &job_status_to_update,
            &job.workspace_id,
            false,
            Arc::new(serde_json::value::to_raw_value(&wrapped_error).unwrap()),
            unrecoverable,
            &same_worker_tx.expect(SAME_WORKER_REQUIREMENTS).clone(),
            worker_dir,
            None,
            worker_name,
            job_completed_tx.clone(),
            #[cfg(feature = "benchmark")]
            bench,
        )
        .await;

        if let Err(err) = updated_flow {
            if let Some(parent_job_id) = job.parent_job {
                if let Ok(Some(parent_job)) =
                    get_queued_job(&parent_job_id, &job.workspace_id, &db).await
                {
                    let e = json!({"message": err.to_string(), "name": "InternalErr"});
                    append_logs(
                        &parent_job.id,
                        &job.workspace_id,
                        format!("Unexpected error during flow job error handling:\n{err}"),
                        &db.into(),
                    )
                    .await;
                    let _ = add_completed_job_error(
                        db,
                        &MiniPulledJob::from(&parent_job),
                        mem_peak,
                        canceled_by.clone(),
                        e,
                        worker_name,
                        false,
                        None,
                    )
                    .await;
                }
            }
        }

        None
    } else {
        Some(update_job_future)
    };
    if let Some(f) = update_job_future {
        let _ = f().await;
    }
}

#[derive(Debug, Serialize)]
pub struct SerializedError {
    pub message: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}
pub fn extract_error_value(
    program: &str,
    log_lines: &str,
    i: i32,
    step_id: Option<String>,
) -> Box<RawValue> {
    return to_raw_value(&SerializedError {
        message: format!(
            "exit code for \"{program}\": {i}, last log lines:\n{}",
            ANSI_ESCAPE_RE.replace_all(log_lines.trim(), "").to_string()
        ),
        name: "ExecutionErr".to_string(),
        step_id,
        exit_code: Some(i),
    });
}
