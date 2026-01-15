import type {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { fetchAtlasModels, getApiBaseUrl, type AtlasCloudApiCredentials, type AtlasCloudModel, atlasApiRequest } from '../../utils/AtlasCloudClient';

function isLlmModel(model: AtlasCloudModel): boolean {
	if (String(model.type) !== 'Text') return false;
	const categories = model.categories || [];
	return categories.includes('LLM') || categories.includes('TEXT') || categories.includes('TEXT-TO-TEXT') || categories.length > 0;
}

export class AtlasCloudChat implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'AtlasCloud Chat',
		name: 'atlasCloudChat',
		icon: 'file:AtlasCloudChat.svg',
		group: ['input'],
		version: 1,
		subtitle: '={{$parameter["modelUuid"]}}',
		description: 'OpenAI-compatible chat completions (AtlasCloud)',
		documentationUrl: 'https://www.atlascloud.ai/docs',
		defaults: { name: 'AtlasCloud Chat' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: 'atlasCloudApi', required: true }],
		properties: [
			{
				displayName: 'Model Name or ID',
				name: 'modelUuid',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getLlmModels' },
				default: '',
				required: true,
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'System Prompt',
				name: 'systemPrompt',
				type: 'string',
				default: '',
				typeOptions: { rows: 4 },
			},
			{
				displayName: 'User Prompt',
				name: 'userPrompt',
				type: 'string',
				default: '',
				required: true,
				typeOptions: { rows: 6 },
			},
			{
				displayName: 'Extra Messages (JSON)',
				name: 'messagesJson',
				type: 'json',
				default: '[]',
				description: 'Optional OpenAI messages array (appended after system/user prompts)',
			},
			{
				displayName: 'Temperature',
				name: 'temperature',
				type: 'number',
				default: 0.7,
			},
			{
				displayName: 'Max Tokens',
				name: 'maxTokens',
				type: 'number',
				default: 1024,
			},
		],
	};

	private static async getSelectedModel(context: ILoadOptionsFunctions | IExecuteFunctions, modelUuid: string): Promise<AtlasCloudModel | undefined> {
		const models = await fetchAtlasModels(context);
		return models.find((m) => m.uuid === modelUuid);
	}

	methods = {
		loadOptions: {
			async getLlmModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const models = (await fetchAtlasModels(this)).filter(isLlmModel);
				return models
					.sort((a, b) => a.displayName.localeCompare(b.displayName))
					.map((m) => ({ name: m.displayName, value: m.uuid, description: m.model }));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const modelUuid = this.getNodeParameter('modelUuid', itemIndex) as string;
				const systemPrompt = this.getNodeParameter('systemPrompt', itemIndex, '') as string;
				const userPrompt = this.getNodeParameter('userPrompt', itemIndex) as string;
				const messagesJson = this.getNodeParameter('messagesJson', itemIndex) as string;
				const temperature = this.getNodeParameter('temperature', itemIndex) as number;
				const maxTokens = this.getNodeParameter('maxTokens', itemIndex) as number;

				const credentials = (await this.getCredentials('atlasCloudApi')) as unknown as AtlasCloudApiCredentials;
				const apiBaseUrl = getApiBaseUrl(credentials);

				const model = await AtlasCloudChat.getSelectedModel(this, modelUuid);
				if (!model) throw new NodeOperationError(this.getNode(), `Unknown model UUID: ${modelUuid}`, { itemIndex });

				const messages: Array<{ role: string; content: string }> = [];
				if (systemPrompt && systemPrompt.trim()) messages.push({ role: 'system', content: systemPrompt });
				if (!userPrompt || !userPrompt.trim()) {
					throw new NodeOperationError(this.getNode(), 'User Prompt is required', { itemIndex });
				}
				messages.push({ role: 'user', content: userPrompt });

				if (messagesJson && messagesJson.trim() && messagesJson.trim() !== '[]') {
					let extra: unknown;
					try {
						extra = JSON.parse(messagesJson);
					} catch (error) {
						throw new NodeOperationError(this.getNode(), `Invalid Extra Messages JSON: ${(error as Error).message}`, { itemIndex });
					}
					if (!Array.isArray(extra)) {
						throw new NodeOperationError(this.getNode(), 'Extra Messages must be a JSON array', { itemIndex });
					}
					for (const m of extra) {
						if (!m || typeof m !== 'object') continue;
						const mm = m as Record<string, unknown>;
						if (typeof mm.role !== 'string' || typeof mm.content !== 'string') continue;
						messages.push({ role: mm.role, content: mm.content });
					}
				}

				const response = await atlasApiRequest(
					this,
					credentials,
					{
						method: 'POST',
						url: '/v1/chat/completions',
						body: {
							model: model.model,
							messages,
							temperature,
							max_tokens: maxTokens,
						},
					},
					itemIndex,
				);

				const responseObj = response as Record<string, unknown>;
				const choices = Array.isArray(responseObj.choices) ? (responseObj.choices as unknown[]) : [];
				let content: string | null = null;
				if (choices[0] && typeof choices[0] === 'object') {
					const choice0 = choices[0] as Record<string, unknown>;
					if (choice0.message && typeof choice0.message === 'object') {
						const msg = choice0.message as Record<string, unknown>;
						if (typeof msg.content === 'string') content = msg.content;
					}
					if (content === null && typeof choice0.text === 'string') content = choice0.text;
				}

				returnData.push({
					json: {
						model_uuid: model.uuid,
						model: model.model,
						api_base_url: apiBaseUrl,
						content,
						raw: response,
					},
					pairedItem: { item: itemIndex },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: error instanceof Error ? error.message : String(error) },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				if (error instanceof NodeOperationError) throw error;
				throw new NodeOperationError(this.getNode(), error instanceof Error ? error : new Error(String(error)), { itemIndex });
			}
		}

		return [returnData];
	}
}
