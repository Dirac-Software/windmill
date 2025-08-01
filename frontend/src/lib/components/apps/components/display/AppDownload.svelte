<script lang="ts">
	import { getContext, untrack } from 'svelte'
	import { twMerge } from 'tailwind-merge'
	import { initConfig, initOutput } from '../../editor/appUtils'
	import { components } from '../../editor/component'
	import type { AppViewerContext, ComponentCustomCSS, RichConfigurations } from '../../types'
	import { initCss, transformBareBase64IfNecessary } from '../../utils'
	import ResolveConfig from '../helpers/ResolveConfig.svelte'
	import InitializeComponent from '../helpers/InitializeComponent.svelte'
	import { Button } from '$lib/components/common'
	import { loadIcon } from '../icon'
	import ComponentErrorHandler from '../helpers/ComponentErrorHandler.svelte'
	import ResolveStyle from '../helpers/ResolveStyle.svelte'
	import AlignWrapper from '../helpers/AlignWrapper.svelte'

	interface Props {
		id: string
		configuration: RichConfigurations
		customCss?: ComponentCustomCSS<'downloadcomponent'> | undefined
		render: boolean
		horizontalAlignment?: 'left' | 'center' | 'right' | undefined
		verticalAlignment?: 'top' | 'center' | 'bottom' | undefined
		noWFull?: boolean
	}

	let {
		id,
		configuration,
		customCss = undefined,
		render,
		horizontalAlignment = undefined,
		verticalAlignment = undefined,
		noWFull = false
	}: Props = $props()

	const resolvedConfig = $state(
		initConfig(components['downloadcomponent'].initialData.configuration, configuration)
	)

	const { app, worldStore } = getContext<AppViewerContext>('AppViewerContext')

	//used so that we can count number of outputs setup for first refresh
	initOutput($worldStore, id, {})

	let beforeIconComponent: any = $state()
	let afterIconComponent: any = $state()

	async function handleBeforeIcon() {
		if (resolvedConfig.beforeIcon) {
			beforeIconComponent = await loadIcon(
				resolvedConfig.beforeIcon,
				beforeIconComponent,
				14,
				undefined,
				undefined
			)
		}
	}

	async function handleAfterIcon() {
		if (resolvedConfig.afterIcon) {
			afterIconComponent = await loadIcon(
				resolvedConfig.afterIcon,
				afterIconComponent,
				14,
				undefined,
				undefined
			)
		}
	}

	let css = $state(initCss($app.css?.downloadcomponent, customCss))
	$effect(() => {
		resolvedConfig.beforeIcon && beforeIconComponent && untrack(() => handleBeforeIcon())
	})
	$effect(() => {
		resolvedConfig.afterIcon && afterIconComponent && untrack(() => handleAfterIcon())
	})
</script>

<InitializeComponent {id} />

{#each Object.keys(components['downloadcomponent'].initialData.configuration) as key (key)}
	<ResolveConfig
		{id}
		{key}
		bind:resolvedConfig={resolvedConfig[key]}
		configuration={configuration[key]}
	/>
{/each}

{#each Object.keys(css ?? {}) as key (key)}
	<ResolveStyle
		{id}
		{customCss}
		{key}
		bind:css={css[key]}
		componentStyle={$app.css?.downloadcomponent}
	/>
{/each}

{#if render}
	<AlignWrapper {noWFull} {horizontalAlignment} {verticalAlignment}>
		<ComponentErrorHandler
			hasError={resolvedConfig?.source != undefined && typeof resolvedConfig.source !== 'string'}
		>
			<Button
				on:pointerdown={(e) => e.stopPropagation()}
				btnClasses={twMerge(
					css?.button?.class,
					'wm-button',
					'wm-download-button',
					resolvedConfig.fillContainer ? 'w-full h-full' : ''
				)}
				wrapperClasses={twMerge(
					'wm-button-container',
					'wm-download-button-container',
					resolvedConfig.fillContainer ? 'w-full h-full' : ''
				)}
				style={css?.button?.style}
				disabled={resolvedConfig.source == undefined}
				size={resolvedConfig.size}
				color={resolvedConfig.color}
				download={resolvedConfig.filename}
				href={transformBareBase64IfNecessary(resolvedConfig.source)}
				target="_blank"
				ref="external"
				nonCaptureEvent
			>
				<span class="truncate inline-flex gap-2 items-center">
					{#if resolvedConfig.beforeIcon}
						{#key resolvedConfig.beforeIcon}
							<div class="min-w-4" bind:this={beforeIconComponent}></div>
						{/key}
					{/if}
					{#if resolvedConfig.label && resolvedConfig.label?.length > 0}
						<div>{resolvedConfig.label}</div>
					{/if}
					{#if resolvedConfig.afterIcon}
						{#key resolvedConfig.afterIcon}
							<div class="min-w-4" bind:this={afterIconComponent}></div>
						{/key}
					{/if}
				</span>
			</Button>
		</ComponentErrorHandler>
	</AlignWrapper>
{/if}
