import type { AIProviderModel, ScriptLang } from '$lib/gen/types.gen'
import type { ScriptOptions } from './ContextManager.svelte'
import {
	flowTools,
	prepareFlowSystemMessage,
	prepareFlowUserMessage,
	type FlowAIChatHelpers
} from './flow/core'
import ContextManager from './ContextManager.svelte'
import HistoryManager from './HistoryManager.svelte'
import { processToolCall, type DisplayMessage, type Tool, type ToolCallbacks } from './shared'
import type {
	ChatCompletionChunk,
	ChatCompletionMessageParam,
	ChatCompletionMessageToolCall,
	ChatCompletionSystemMessageParam,
	ChatCompletionUserMessageParam
} from 'openai/resources/chat/completions.mjs'
import {
	INLINE_CHAT_SYSTEM_PROMPT,
	prepareScriptSystemMessage,
	prepareScriptTools
} from './script/core'
import { navigatorTools, prepareNavigatorSystemMessage } from './navigator/core'
import { loadApiTools } from './navigator/apiTools'
import { prepareScriptUserMessage } from './script/core'
import { prepareNavigatorUserMessage } from './navigator/core'
import { sendUserToast } from '$lib/toast'
import { getCompletion, getModelContextWindow } from '../lib'
import { dfs } from '$lib/components/flows/previousResults'
import { getStringError } from './utils'
import type { FlowModuleState, FlowState } from '$lib/components/flows/flowState'
import type { CurrentEditor, ExtendedOpenFlow } from '$lib/components/flows/types'
import { untrack } from 'svelte'
import { copilotSessionModel, type DBSchemas } from '$lib/stores'
import { askTools, prepareAskSystemMessage } from './ask/core'
import { chatState, DEFAULT_SIZE, triggerablesByAi } from './sharedChatState.svelte'
import type { ContextElement } from './context'
import type { Selection } from 'monaco-editor'
import type AIChatInput from './AIChatInput.svelte'
import { get } from 'svelte/store'

// If the estimated token usage is greater than the model context window - the threshold, we delete the oldest message
const MAX_TOKENS_THRESHOLD_PERCENTAGE = 0.05
const MAX_TOKENS_HARD_LIMIT = 5000

export enum AIMode {
	SCRIPT = 'script',
	FLOW = 'flow',
	NAVIGATOR = 'navigator',
	ASK = 'ask'
}

class AIChatManager {
	NAVIGATION_SYSTEM_PROMPT = `
	CONSIDERATIONS:
	 - You are provided with a tool to switch to navigation mode, only use it when you are sure that the user is asking you to navigate the application, help them find something or fetch data from the API. Do not use it otherwise.
	`
	contextManager = new ContextManager()
	historyManager = new HistoryManager()
	abortController: AbortController | undefined = undefined

	mode = $state<AIMode>(AIMode.NAVIGATOR)
	readonly isOpen = $derived(chatState.size > 0)
	savedSize = $state<number>(0)
	instructions = $state<string>('')
	pendingPrompt = $state<string>('')
	loading = $state<boolean>(false)
	currentReply = $state<string>('')
	displayMessages = $state<DisplayMessage[]>([])
	messages = $state<ChatCompletionMessageParam[]>([])
	#automaticScroll = $state<boolean>(true)
	systemMessage = $state<ChatCompletionSystemMessageParam>({
		role: 'system',
		content: ''
	})
	tools = $state<Tool<any>[]>([])
	helpers = $state<any | undefined>(undefined)

	scriptEditorOptions = $state<ScriptOptions | undefined>(undefined)
	scriptEditorApplyCode = $state<((code: string) => void) | undefined>(undefined)
	scriptEditorShowDiffMode = $state<(() => void) | undefined>(undefined)
	flowAiChatHelpers = $state<FlowAIChatHelpers | undefined>(undefined)
	pendingNewCode = $state<string | undefined>(undefined)
	apiTools = $state<Tool<any>[]>([])
	aiChatInput = $state<AIChatInput | null>(null)

	allowedModes: Record<AIMode, boolean> = $derived({
		script: this.scriptEditorOptions !== undefined,
		flow: this.flowAiChatHelpers !== undefined,
		navigator: true,
		ask: true
	})

	open = $derived(chatState.size > 0)

	checkTokenUsageOverLimit = (messages: ChatCompletionMessageParam[]) => {
		const estimatedTokens = messages.reduce((acc, message) => {
			// one token is ~ 4 characters
			const tokenPerCharacter = 4
			// handle content
			if (message.content) {
				acc += message.content.length / tokenPerCharacter
			}
			// Handle tool calls
			if (message.role === 'assistant' && message.tool_calls) {
				acc += JSON.stringify(message.tool_calls).length / tokenPerCharacter
			}
			return acc
		}, 0)
		const modelContextWindow = getModelContextWindow(get(copilotSessionModel)?.model ?? '')
		return (
			estimatedTokens >
			modelContextWindow -
				Math.max(modelContextWindow * MAX_TOKENS_THRESHOLD_PERCENTAGE, MAX_TOKENS_HARD_LIMIT)
		)
	}

	deleteOldestMessage = (messages: ChatCompletionMessageParam[], maxDepth: number = 10) => {
		if (maxDepth <= 0 || messages.length <= 1) {
			return messages
		}
		const removed = messages.shift()

		// if the removed message is an assistant with tool calls, we need to delete correspding tool response.
		if (removed?.role === 'assistant' && removed.tool_calls) {
			if (messages.length > 0 && messages[0]?.role === 'tool') {
				messages.shift()
			}
		}

		// keep deleting messages until we are under the limit
		if (this.checkTokenUsageOverLimit(messages)) {
			return this.deleteOldestMessage(messages, maxDepth - 1)
		}
		return messages
	}

	loadApiTools = async () => {
		try {
			this.apiTools = await loadApiTools()
			if (this.mode === AIMode.NAVIGATOR) {
				this.tools = [this.changeModeTool, ...navigatorTools, ...this.apiTools]
			}
		} catch (err) {
			console.error('Error loading api tools', err)
			this.apiTools = []
		}
	}

	setAiChatInput(aiChatInput: AIChatInput | null) {
		this.aiChatInput = aiChatInput
	}

	focusInput() {
		if (this.aiChatInput) {
			this.aiChatInput.focusInput()
		}
	}

	updateMode(currentMode: AIMode) {
		if (
			!this.allowedModes[currentMode] &&
			Object.keys(this.allowedModes).filter((k) => this.allowedModes[k]).length === 1
		) {
			const firstKey = Object.keys(this.allowedModes).filter((k) => this.allowedModes[k])[0]
			this.changeMode(firstKey as AIMode)
		}
	}

	changeMode(
		mode: AIMode,
		pendingPrompt?: string,
		options?: {
			closeScriptSettings?: boolean
		}
	) {
		this.mode = mode
		this.pendingPrompt = pendingPrompt ?? ''
		if (mode === AIMode.SCRIPT) {
			this.systemMessage = prepareScriptSystemMessage()
			this.systemMessage.content = this.NAVIGATION_SYSTEM_PROMPT + this.systemMessage.content
			const context = this.contextManager.getSelectedContext()
			const lang = this.scriptEditorOptions?.lang ?? 'bun'
			this.tools = [this.changeModeTool, ...prepareScriptTools(lang, context)]
			this.helpers = {
				getLang: () => lang
			}
			if (options?.closeScriptSettings) {
				const closeComponent = triggerablesByAi['close-script-builder-settings']
				if (closeComponent) {
					closeComponent.onTrigger?.()
				}
			}
		} else if (mode === AIMode.FLOW) {
			this.systemMessage = prepareFlowSystemMessage()
			this.systemMessage.content = this.NAVIGATION_SYSTEM_PROMPT + this.systemMessage.content
			this.tools = [this.changeModeTool, ...flowTools]
			this.helpers = this.flowAiChatHelpers
		} else if (mode === AIMode.NAVIGATOR) {
			this.systemMessage = prepareNavigatorSystemMessage()
			this.tools = [this.changeModeTool, ...navigatorTools, ...this.apiTools]
			this.helpers = {}
		} else if (mode === AIMode.ASK) {
			this.systemMessage = prepareAskSystemMessage()
			this.tools = [...askTools]
			this.helpers = {}
		}
	}

	canApplyCode = $derived(this.allowedModes.script && this.mode === AIMode.SCRIPT)

	private changeModeTool = {
		def: {
			type: 'function' as const,
			function: {
				name: 'change_mode',
				description:
					'Change the AI mode to the one specified. Script mode is used to create scripts, and flow mode is used to create flows. Navigator mode is used to navigate the application and help the user find what they are looking for.',
				parameters: {
					type: 'object',
					properties: {
						mode: {
							type: 'string',
							description: 'The mode to change to',
							enum: ['script', 'flow', 'navigator']
						},
						pendingPrompt: {
							type: 'string',
							description: 'The prompt to send to the new mode to fulfill the user request',
							default: ''
						}
					},
					required: ['mode']
				}
			}
		},
		fn: async ({ args, toolId, toolCallbacks }) => {
			toolCallbacks.setToolStatus(toolId, 'Switching to ' + args.mode + ' mode...')
			this.changeMode(args.mode as AIMode, args.pendingPrompt, {
				closeScriptSettings: true
			})
			toolCallbacks.setToolStatus(toolId, 'Switched to ' + args.mode + ' mode')
			return 'Mode changed to ' + args.mode
		}
	}

	openChat = () => {
		chatState.size = this.savedSize > 0 ? this.savedSize : DEFAULT_SIZE
		localStorage.setItem('ai-chat-open', 'true')
	}

	closeChat = () => {
		this.savedSize = chatState.size
		chatState.size = 0
		localStorage.setItem('ai-chat-open', 'false')
	}

	toggleOpen = () => {
		if (chatState.size > 0) {
			this.savedSize = chatState.size
		}
		chatState.size = chatState.size === 0 ? (this.savedSize > 0 ? this.savedSize : DEFAULT_SIZE) : 0
		localStorage.setItem('ai-chat-open', chatState.size === 0 ? 'false' : 'true')
	}

	askAi = (
		prompt: string,
		options: { withCode?: boolean; withDiff?: boolean } = {
			withCode: true,
			withDiff: false
		}
	) => {
		if (this.scriptEditorOptions) {
			this.contextManager.setAskAiContext(options)
		}
		this.instructions = prompt
		this.sendRequest({
			removeDiff: options.withDiff,
			addBackCode: options.withCode === false
		})
		if (options.withDiff) {
			this.scriptEditorShowDiffMode?.()
		}
	}

	retryRequest = (messageIndex: number) => {
		const message = this.displayMessages[messageIndex]
		if (message && message.role === 'user') {
			this.restartGeneration(messageIndex)
			message.error = false
		} else {
			throw new Error('No user message found at the specified index')
		}
	}

	private getLastUserMessage = () => {
		for (let i = this.displayMessages.length - 1; i >= 0; i--) {
			const message = this.displayMessages[i]
			if (message.role === 'user') {
				return message
			}
		}
	}

	private flagLastMessageAsError = () => {
		const lastUserMessage = this.getLastUserMessage()
		if (lastUserMessage) {
			lastUserMessage.error = true
		}
	}

	private chatRequest = async ({
		messages,
		abortController,
		callbacks,
		systemMessage: systemMessageOverride
	}: {
		messages: ChatCompletionMessageParam[]
		abortController: AbortController
		callbacks: ToolCallbacks & {
			onNewToken: (token: string) => void
			onMessageEnd: () => void
		}
		systemMessage?: ChatCompletionSystemMessageParam
	}) => {
		let addedMessages: ChatCompletionMessageParam[] = []
		try {
			let completion: any = null

			while (true) {
				const systemMessage = systemMessageOverride ?? this.systemMessage
				const tools = this.tools
				const helpers = this.helpers

				let pendingPrompt = this.pendingPrompt
				let pendingUserMessage: ChatCompletionUserMessageParam | undefined = undefined
				if (pendingPrompt) {
					if (this.mode === AIMode.SCRIPT) {
						pendingUserMessage = await prepareScriptUserMessage(
							pendingPrompt,
							this.scriptEditorOptions?.lang as ScriptLang | 'bunnative',
							this.contextManager.getSelectedContext()
						)
					} else if (this.mode === AIMode.FLOW) {
						pendingUserMessage = prepareFlowUserMessage(
							pendingPrompt,
							this.flowAiChatHelpers!.getFlowAndSelectedId()
						)
					} else if (this.mode === AIMode.NAVIGATOR) {
						pendingUserMessage = prepareNavigatorUserMessage(pendingPrompt)
					}
					this.pendingPrompt = ''
				}
				completion = await getCompletion(
					[systemMessage, ...messages, ...(pendingUserMessage ? [pendingUserMessage] : [])],
					abortController,
					tools.map((t) => t.def)
				)

				if (completion) {
					const finalToolCalls: Record<number, ChatCompletionChunk.Choice.Delta.ToolCall> = {}

					let answer = ''
					for await (const chunk of completion) {
						if (!('choices' in chunk && chunk.choices.length > 0 && 'delta' in chunk.choices[0])) {
							continue
						}
						const c = chunk as ChatCompletionChunk
						const delta = c.choices[0].delta.content
						if (delta) {
							answer += delta
							callbacks.onNewToken(delta)
						}
						const toolCalls = c.choices[0].delta.tool_calls || []
						if (toolCalls.length > 0 && answer) {
							// if tool calls are present but we have some textual content already, we need to display it to the user first
							callbacks.onMessageEnd()
							answer = ''
						}
						for (const toolCall of toolCalls) {
							const { index } = toolCall
							let finalToolCall = finalToolCalls[index]
							if (!finalToolCall) {
								finalToolCalls[index] = toolCall
							} else {
								if (toolCall.function?.arguments) {
									if (!finalToolCall.function) {
										finalToolCall.function = toolCall.function
									} else {
										finalToolCall.function.arguments =
											(finalToolCall.function.arguments ?? '') + toolCall.function.arguments
									}
								}
							}
							finalToolCall = finalToolCalls[index]
							if (finalToolCall?.function) {
								const {
									function: { name: funcName },
									id: toolCallId
								} = finalToolCall
								if (funcName && toolCallId) {
									const tool = tools.find((t) => t.def.function.name === funcName)
									if (tool && tool.preAction) {
										tool.preAction({ toolCallbacks: callbacks, toolId: toolCallId })
									}
								}
							}
						}
					}

					if (answer) {
						const toAdd = { role: 'assistant' as const, content: answer }
						addedMessages.push(toAdd)
						messages.push(toAdd)
					}

					callbacks.onMessageEnd()

					const toolCalls = Object.values(finalToolCalls).filter(
						(toolCall) => toolCall.id !== undefined && toolCall.function?.arguments !== undefined
					) as ChatCompletionMessageToolCall[]

					if (toolCalls.length > 0) {
						const toAdd = {
							role: 'assistant' as const,
							tool_calls: toolCalls.map((t) => ({
								...t,
								function: {
									...t.function,
									arguments: t.function.arguments || '{}'
								}
							}))
						}
						messages.push(toAdd)
						addedMessages.push(toAdd)
						for (const toolCall of toolCalls) {
							const messageToAdd = await processToolCall({
								tools,
								toolCall,
								messages,
								helpers,
								toolCallbacks: callbacks
							})
							messages.push(messageToAdd)
							addedMessages.push(messageToAdd)
						}
					} else {
						break
					}
				}
			}
			return addedMessages
		} catch (err) {
			callbacks.onMessageEnd()
			if (!abortController.signal.aborted) {
				throw err
			}
		}
	}

	sendInlineRequest = async (instructions: string, selectedCode: string, selection: Selection) => {
		// Validate inputs
		if (!instructions.trim()) {
			throw new Error('Instructions are required')
		}
		this.abortController = new AbortController()
		const lang = this.scriptEditorOptions?.lang ?? 'bun'
		const selectedContext: ContextElement[] = [...this.contextManager.getSelectedContext()]
		const startLine = selection.startLineNumber
		const endLine = selection.endLineNumber
		selectedContext.push({
			type: 'code_piece',
			lang,
			title: `L${startLine}-L${endLine}`,
			startLine,
			endLine,
			content: selectedCode
		})

		const systemMessage: ChatCompletionSystemMessageParam = {
			role: 'system',
			content: INLINE_CHAT_SYSTEM_PROMPT
		}

		let reply = ''

		try {
			const userMessage = await prepareScriptUserMessage(instructions, lang, selectedContext, {
				isPreprocessor: false
			})
			const messages = [userMessage]

			const params = {
				messages,
				abortController: this.abortController,
				callbacks: {
					onNewToken: (token: string) => {
						reply += token
					},
					onMessageEnd: () => {},
					setToolStatus: () => {}
				},
				systemMessage
			}

			await this.chatRequest({ ...params })

			// Validate we received a response
			if (!reply.trim()) {
				throw new Error('AI response was empty')
			}

			// Try to extract new code from response
			const newCodeMatch = reply.match(/<new_code>([\s\S]*?)<\/new_code>/i)
			if (newCodeMatch && newCodeMatch[1]) {
				const code = newCodeMatch[1].trim()
				if (!code) {
					throw new Error('AI response contained empty code block')
				}
				return code
			}

			// Fallback: try to take everything after the last <new_code> tag
			const lastNewCodeMatch = reply.match(/<new_code>([\s\S]*)/i)
			if (lastNewCodeMatch && lastNewCodeMatch[1]) {
				const code = lastNewCodeMatch[1].trim().replace(/```/g, '')
				if (!code) {
					throw new Error('AI response contained empty code block')
				}
				return code
			}

			// If no code tags found, throw error with helpful message
			throw new Error('AI response did not contain valid code. Please try rephrasing your request.')
		} catch (error) {
			// if abort controller is aborted, don't throw an error
			if (this.abortController?.signal.aborted) {
				return
			}
			console.error('Unexpected error in sendInlineRequest:', error)
			throw new Error('An unexpected error occurred. Please try again.')
		}
	}

	sendRequest = async (
		options: {
			removeDiff?: boolean
			addBackCode?: boolean
			instructions?: string
			mode?: AIMode
			lang?: ScriptLang | 'bunnative'
			isPreprocessor?: boolean
		} = {}
	) => {
		if (options.mode) {
			this.changeMode(options.mode)
		} else {
			this.changeMode(this.mode)
		}
		if (options.instructions) {
			this.instructions = options.instructions
		}
		if (!this.instructions.trim()) {
			return
		}
		try {
			const oldSelectedContext = this.contextManager?.getSelectedContext() ?? []
			if (this.mode === AIMode.SCRIPT) {
				this.contextManager?.updateContextOnRequest(options)
			}
			this.loading = true
			this.#automaticScroll = true
			this.abortController = new AbortController()

			if (this.mode === AIMode.FLOW && !this.flowAiChatHelpers) {
				throw new Error('No flow helpers found')
			}

			let snapshot: ExtendedOpenFlow | undefined = undefined
			if (this.mode === AIMode.FLOW) {
				this.flowAiChatHelpers!.rejectAllModuleActions()
				snapshot = this.flowAiChatHelpers!.getFlowAndSelectedId().flow
				this.flowAiChatHelpers!.setLastSnapshot(snapshot)
			}

			this.displayMessages = [
				...this.displayMessages,
				{
					role: 'user',
					content: this.instructions,
					contextElements: this.mode === AIMode.SCRIPT ? oldSelectedContext : undefined,
					snapshot,
					index: this.messages.length // matching with actual messages index. not -1 because it's not yet added to the messages array
				}
			]
			const oldInstructions = this.instructions
			this.instructions = ''

			if (this.mode === AIMode.SCRIPT && !this.scriptEditorOptions && !options.lang) {
				throw new Error('No script options passed')
			}

			const lang = this.scriptEditorOptions?.lang ?? options.lang ?? 'bun'
			const isPreprocessor =
				this.scriptEditorOptions?.path === 'preprocessor' || options.isPreprocessor

			const userMessage =
				this.mode === AIMode.FLOW
					? prepareFlowUserMessage(oldInstructions, this.flowAiChatHelpers!.getFlowAndSelectedId())
					: this.mode === AIMode.NAVIGATOR
						? prepareNavigatorUserMessage(oldInstructions)
						: await prepareScriptUserMessage(oldInstructions, lang, oldSelectedContext, {
								isPreprocessor
							})

			this.messages.push(userMessage)
			await this.historyManager.saveChat(this.displayMessages, this.messages)

			this.currentReply = ''

			let trimmedMessages = [...this.messages]
			if (this.checkTokenUsageOverLimit(trimmedMessages)) {
				trimmedMessages = this.deleteOldestMessage(trimmedMessages)
			}

			const params: {
				messages: ChatCompletionMessageParam[]
				abortController: AbortController
				callbacks: ToolCallbacks & {
					onNewToken: (token: string) => void
					onMessageEnd: () => void
				}
			} = {
				messages: trimmedMessages,
				abortController: this.abortController,
				callbacks: {
					onNewToken: (token) => (this.currentReply += token),
					onMessageEnd: () => {
						if (this.currentReply) {
							this.displayMessages = [
								...this.displayMessages,
								{
									role: 'assistant',
									content: this.currentReply,
									contextElements:
										this.mode === AIMode.SCRIPT
											? oldSelectedContext.filter((c) => c.type === 'code')
											: undefined
								}
							]
						}
						this.currentReply = ''
					},
					setToolStatus: (id, content) => {
						const existingIdx = this.displayMessages.findIndex(
							(m) => m.role === 'tool' && m.tool_call_id === id
						)
						if (existingIdx !== -1) {
							this.displayMessages[existingIdx].content = content
						} else {
							this.displayMessages.push({ role: 'tool', tool_call_id: id, content })
						}
					}
				}
			}

			if (this.mode === AIMode.NAVIGATOR && this.apiTools.length === 0) {
				await this.loadApiTools()
			}

			const addedMessages = await this.chatRequest({
				...params
			})
			this.messages = [...this.messages, ...(addedMessages ?? [])]

			await this.historyManager.saveChat(this.displayMessages, this.messages)
		} catch (err) {
			console.error(err)
			this.flagLastMessageAsError()
			if (err instanceof Error) {
				sendUserToast('Failed to send request: ' + err.message, true)
			} else {
				sendUserToast('Failed to send request', true)
			}
		} finally {
			this.loading = false
		}
	}

	cancel = () => {
		this.abortController?.abort()
	}

	restartGeneration = (displayMessageIndex: number, newContent?: string) => {
		const userMessage = this.displayMessages[displayMessageIndex]

		if (!userMessage || userMessage.role !== 'user') {
			throw new Error('No user message found at the specified index')
		}

		// Remove all messages including and after the specified user message
		this.displayMessages = this.displayMessages.slice(0, displayMessageIndex)

		// Find corresponding message in actual messages and remove it and everything after it
		let actualMessageIndex = this.messages.findIndex((_, i) => i === userMessage.index)

		if (actualMessageIndex === -1) {
			throw new Error('No actual user message found to restart from')
		}

		this.messages = this.messages.slice(0, actualMessageIndex)

		// Resend the request with the same instructions
		this.instructions = newContent ?? userMessage.content
		this.sendRequest()
	}

	fix = () => {
		if (!this.open) {
			this.toggleOpen()
		}
		this.changeMode(AIMode.SCRIPT)
		this.instructions = 'Fix the error'
		this.contextManager?.setFixContext()
		this.sendRequest()
	}

	addSelectedLinesToContext = (lines: string, startLine: number, endLine: number) => {
		if (!this.open) {
			this.toggleOpen()
		}
		this.changeMode(AIMode.SCRIPT)
		this.contextManager?.addSelectedLinesToContext(lines, startLine, endLine)
		this.focusInput()
	}

	saveAndClear = async () => {
		await this.historyManager.save(this.displayMessages, this.messages)
		this.displayMessages = []
		this.messages = []
	}

	loadPastChat = async (id: string) => {
		const chat = this.historyManager.loadPastChat(id)
		if (chat) {
			this.displayMessages = chat.displayMessages
			this.messages = chat.actualMessages
			this.#automaticScroll = true
		}
	}

	get automaticScroll() {
		return this.#automaticScroll
	}

	disableAutomaticScroll = () => {
		this.#automaticScroll = false
	}

	generateStep = async (moduleId: string, lang: ScriptLang, instructions: string) => {
		if (!this.flowAiChatHelpers) {
			throw new Error('No flow helpers found')
		}
		this.flowAiChatHelpers.selectStep(moduleId)
		await this.sendRequest({
			instructions: instructions,
			mode: AIMode.SCRIPT,
			lang: lang,
			isPreprocessor: moduleId === 'preprocessor'
		})
	}

	listenForScriptEditorContextChange = (
		dbSchemas: DBSchemas,
		workspaceStore: string | undefined,
		copilotSessionModel: AIProviderModel | undefined
	) => {
		if (this.scriptEditorOptions) {
			this.contextManager.updateAvailableContext(
				this.scriptEditorOptions,
				dbSchemas,
				workspaceStore ?? '',
				!copilotSessionModel?.model.endsWith('/thinking'),
				untrack(() => this.contextManager.getSelectedContext())
			)
		}
	}

	listenForDbSchemasChanges = (dbSchemas: DBSchemas) => {
		this.displayMessages = ContextManager.updateDisplayMessages(
			untrack(() => this.displayMessages),
			dbSchemas
		)
	}

	listenForCurrentEditorChanges = (currentEditor: CurrentEditor) => {
		if (currentEditor && currentEditor.type === 'script') {
			this.scriptEditorApplyCode = (code) => {
				if (currentEditor && currentEditor.type === 'script') {
					currentEditor.hideDiffMode()
					currentEditor.editor.reviewAndApplyCode(code)
				}
			}
			this.scriptEditorShowDiffMode = () => {
				if (currentEditor && currentEditor.type === 'script') {
					currentEditor.showDiffMode()
				}
			}
		} else {
			this.scriptEditorApplyCode = undefined
			this.scriptEditorShowDiffMode = undefined
		}

		return () => {
			this.scriptEditorApplyCode = undefined
			this.scriptEditorShowDiffMode = undefined
		}
	}

	listenForSelectedIdChanges = (
		selectedId: string,
		flowStore: ExtendedOpenFlow,
		flowStateStore: FlowState,
		currentEditor: CurrentEditor
	) => {
		function getModule(id: string) {
			if (id === 'preprocessor') {
				return flowStore.value.preprocessor_module
			} else if (id === 'failure') {
				return flowStore.value.failure_module
			} else {
				return dfs(id, flowStore, false)[0]
			}
		}

		function getScriptOptions(id: string): ScriptOptions | undefined {
			const module = getModule(id)

			if (module && module.value.type === 'rawscript') {
				const moduleState: FlowModuleState | undefined = flowStateStore[module.id]

				const editorRelated =
					currentEditor && currentEditor.type === 'script' && currentEditor.stepId === module.id
						? {
								diffMode: currentEditor.diffMode,
								lastDeployedCode: currentEditor.lastDeployedCode,
								lastSavedCode: undefined
							}
						: {
								diffMode: false,
								lastDeployedCode: undefined,
								lastSavedCode: undefined
							}

				return {
					args: moduleState?.previewArgs ?? {},
					error:
						moduleState && !moduleState.previewSuccess
							? getStringError(moduleState.previewResult)
							: undefined,
					code: module.value.content,
					lang: module.value.language,
					path: module.id,
					...editorRelated
				}
			}

			return undefined
		}

		if (selectedId) {
			const options = getScriptOptions(selectedId)
			if (options) {
				this.scriptEditorOptions = options
			}
		} else {
			this.scriptEditorOptions = undefined
		}

		return () => {
			this.scriptEditorOptions = undefined
		}
	}

	setFlowHelpers = (flowHelpers: FlowAIChatHelpers) => {
		this.flowAiChatHelpers = flowHelpers

		return () => {
			this.flowAiChatHelpers = undefined
		}
	}
}

export const aiChatManager = new AIChatManager()
