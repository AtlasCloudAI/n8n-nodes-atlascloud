import type {
	FieldType,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	IDataObject,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	ResourceMapperField,
	ResourceMapperFields,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	atlasApiRequest,
	coerceValueForParameter,
	fetchAtlasModels,
	fetchSchemaByUrl,
	formatCategoryName,
	getApiBaseUrl,
	isEmptyValue,
	modelMatchesCategory,
	parseJsonSchemaToParameters,
	waitForPredictionCompletion,
	type AtlasCloudModel,
	type AtlasCloudApiCredentials,
	type AtlasModelParameter,
} from '../../utils/AtlasCloudClient';

export class AtlasCloudTaskSubmit implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'AtlasCloud Task Submit',
		name: 'atlasCloudTaskSubmit',
		icon: 'file:AtlasCloudTaskSubmit.svg',
		group: ['input'],
		version: 1,
		subtitle: '={{$parameter["category"] + " - " + $parameter["modelUuid"]}}',
		description: 'Submit image/video generation tasks to AtlasCloud (schema-driven parameters)',
		documentationUrl: 'https://www.atlascloud.ai/docs',
		defaults: {
			name: 'AtlasCloud Task Submit',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,

		credentials: [{ name: 'atlasCloudApi', required: true }],
		properties: [
			{
				displayName: 'Category Name or ID',
				name: 'category',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getModelCategories' },
				default: '',
				required: true,
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Model Name or ID',
				name: 'modelUuid',
				type: 'options',
				typeOptions: { loadOptionsDependsOn: ['category'], loadOptionsMethod: 'getModels' },
				default: '',
				required: true,
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				displayOptions: { hide: { category: [''] } },
			},
			{
				displayName: 'Prompt (STRING)',
				name: 'prompt',
				type: 'string',
				default: '',
				required: true,
				typeOptions: {
					rows: 6,
				},
				displayOptions: { hide: { modelUuid: [''] } },
				description: 'Text prompt sent to the selected model',
			},
			{
				displayName: 'Required Parameters',
				name: 'requiredParameters',
				type: 'resourceMapper',
				default: { value: null },
				noDataExpression: true,
				typeOptions: {
					loadOptionsDependsOn: ['modelUuid'],
					resourceMapper: {
						resourceMapperMethod: 'getRequiredParameterColumns',
						mode: 'add',
						fieldWords: { singular: 'required parameter', plural: 'required parameters' },
						addAllFields: true,
						noFieldsError: 'No required parameters for this model',
						supportAutoMap: false,
					},
				},
				displayOptions: { hide: { modelUuid: [''] } },
				description: 'Required parameters from the model schema (excluding Prompt)',
			},
			{
				displayName: 'Add Optional Parameter to Send',
				name: 'optionalParameters',
				type: 'resourceMapper',
				default: { value: null, mappingMode: 'defineBelow' },
				typeOptions: {
					loadOptionsDependsOn: ['modelUuid'],
					resourceMapper: {
						resourceMapperMethod: 'getOptionalParameterColumns',
						mode: 'add',
						fieldWords: { singular: 'optional parameter', plural: 'optional parameters' },
						addAllFields: false,
						multiKeyMatch: false,
						supportAutoMap: false,
						noFieldsError: 'No optional parameters available for this model',
					},
				},
				displayOptions: { hide: { modelUuid: [''] } },
				description: 'Add optional parameters to send (from the model schema, excluding Prompt)',
			},
			{
				displayName: 'Execution Mode',
				name: 'executionMode',
				type: 'options',
				options: [
					{ name: 'Submit Only', value: 'submit', description: 'Return prediction ID immediately' },
					{ name: 'Wait for Completion', value: 'wait', description: 'Poll until completed and return outputs' },
				],
				default: 'submit',
			},
			{
				displayName: 'Polling Options',
				name: 'pollingOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { executionMode: ['wait'] } },
				options: [
					{
						displayName: 'Max Wait Time (Minutes)',
						name: 'maxWaitTime',
						type: 'number',
						default: 15,
					},
					{
						displayName: 'Poll Interval (Seconds)',
						name: 'pollInterval',
						type: 'number',
						default: 2,
					},
					{
						displayName: 'Max Retries (Status Errors)',
						name: 'maxRetries',
						type: 'number',
						default: 20,
						typeOptions: { minValue: 1, maxValue: 100 },
					},
				],
			},
		],
	};

	private static toFieldType(paramType: AtlasModelParameter['type']): FieldType {
		switch (paramType) {
			case 'number':
				return 'number';
			case 'boolean':
				return 'boolean';
			case 'options':
				return 'options';
			case 'collection':
				return 'string';
			default:
				return 'string';
		}
	}

	private static async getSelectedModel(context: ILoadOptionsFunctions | IExecuteFunctions, modelUuid: string): Promise<AtlasCloudModel | undefined> {
		const models = await fetchAtlasModels(context);
		return models.find((m) => m.uuid === modelUuid);
	}

	private static async getModelParameters(context: ILoadOptionsFunctions | IExecuteFunctions, model: AtlasCloudModel): Promise<AtlasModelParameter[]> {
		if (!model.schema) return [];
		const schema = await fetchSchemaByUrl(context, model.schema);
		return parseJsonSchemaToParameters(schema);
	}

	methods = {
		loadOptions: {
			async getModelCategories(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const models = (await fetchAtlasModels(this)).filter((m) => m.type === 'Image' || m.type === 'Video');
				const categories = new Set<string>();
				for (const m of models) for (const c of m.categories || []) categories.add(c);
				return [
					{ name: 'Select a Category…', value: '' },
					...Array.from(categories)
						.sort()
						.map((c) => ({ name: formatCategoryName(c), value: c })),
				];
			},

			async getModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const category = this.getCurrentNodeParameter('category') as string;
				if (!category) return [];
				const models = (await fetchAtlasModels(this))
					.filter((m) => m.type === 'Image' || m.type === 'Video')
					.filter((m) => modelMatchesCategory(m, category));

				return models
					.sort((a, b) => a.displayName.localeCompare(b.displayName))
					.map((m) => ({
						name: m.displayName,
						value: m.uuid,
						description: m.model,
					}));
			},
		},

		resourceMapping: {
			async getRequiredParameterColumns(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
				const modelUuid = this.getCurrentNodeParameter('modelUuid') as string;
				if (!modelUuid) return { fields: [] };
				const model = await AtlasCloudTaskSubmit.getSelectedModel(this, modelUuid);
				if (!model) return { fields: [] };

				const params = await AtlasCloudTaskSubmit.getModelParameters(this, model);
				const required = params.filter((p) => p.required && p.name !== 'prompt' && p.name !== 'model');

				const fields: ResourceMapperField[] = required.map((p) => {
					const field: ResourceMapperField = {
						id: p.name,
						displayName: `${p.displayName} (${p.type.toUpperCase()}) *`,
						required: true,
						defaultMatch: false,
						canBeUsedToMatch: false,
						display: true,
						type: AtlasCloudTaskSubmit.toFieldType(p.type),
					};
					if (p.type === 'options' && p.options) {
						field.options = p.options.map((o) => ({ name: o.name, value: o.value, description: o.description }));
					}
					return field;
				});
				return { fields };
			},

			async getOptionalParameterColumns(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
				const modelUuid = this.getCurrentNodeParameter('modelUuid') as string;
				if (!modelUuid) return { fields: [] };
				const model = await AtlasCloudTaskSubmit.getSelectedModel(this, modelUuid);
				if (!model) return { fields: [] };

				const params = await AtlasCloudTaskSubmit.getModelParameters(this, model);
				const optional = params.filter((p) => !p.required && p.name !== 'prompt' && p.name !== 'model');

				const fields: ResourceMapperField[] = optional.map((p) => {
					const field: ResourceMapperField = {
						id: p.name,
						displayName: `${p.displayName} (${p.type.toUpperCase()})`,
						required: false,
						defaultMatch: false,
						canBeUsedToMatch: false,
						display: true,
						type: AtlasCloudTaskSubmit.toFieldType(p.type),
					};
					if (p.type === 'options' && p.options) {
						field.options = p.options.map((o) => ({ name: o.name, value: o.value, description: o.description }));
					}
					return field;
				});
				return { fields };
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const category = this.getNodeParameter('category', itemIndex) as string;
				const modelUuid = this.getNodeParameter('modelUuid', itemIndex) as string;
				const prompt = this.getNodeParameter('prompt', itemIndex) as string;
				const executionMode = this.getNodeParameter('executionMode', itemIndex) as string;

				const credentials = (await this.getCredentials('atlasCloudApi')) as unknown as AtlasCloudApiCredentials & {
					apiBaseUrl?: string;
				};
				const apiBaseUrl = getApiBaseUrl(credentials);

				const model = await AtlasCloudTaskSubmit.getSelectedModel(this, modelUuid);
				if (!model) {
					throw new NodeOperationError(this.getNode(), `Unknown model UUID: ${modelUuid}`, { itemIndex });
				}
				if (model.type !== 'Image' && model.type !== 'Video') {
					throw new NodeOperationError(this.getNode(), `Unsupported model type "${model.type}" for this node`, { itemIndex });
				}

				const parameters = await AtlasCloudTaskSubmit.getModelParameters(this, model);
				const paramMap = new Map(parameters.map((p) => [p.name, p]));

				if (!prompt || !prompt.trim()) {
					throw new NodeOperationError(this.getNode(), 'Prompt is required', { itemIndex });
				}

				const requestData: IDataObject = { model: model.model, prompt };

				type ResourceMapperValue = { value?: Record<string, unknown> | null };
				const requiredParametersValue = this.getNodeParameter('requiredParameters', itemIndex, {}) as ResourceMapperValue;
				if (requiredParametersValue.value) {
					for (const [name, rawValue] of Object.entries(requiredParametersValue.value)) {
						if (name === 'prompt' || name === 'model') continue;
						const def = paramMap.get(name) ?? ({ name, displayName: name, type: 'string', default: '' } as AtlasModelParameter);
						if (isEmptyValue(rawValue)) {
							throw new NodeOperationError(this.getNode(), `Required parameter '${name}' is missing`, { itemIndex });
						}
						const coerced = coerceValueForParameter(rawValue, def as AtlasModelParameter);
						if (coerced !== undefined) requestData[name] = coerced;
					}
				}

				const optionalParametersValue = this.getNodeParameter('optionalParameters', itemIndex, {}) as ResourceMapperValue;
				if (optionalParametersValue.value) {
					for (const [name, rawValue] of Object.entries(optionalParametersValue.value)) {
						if (name === 'prompt' || name === 'model') continue;
						if (isEmptyValue(rawValue)) continue;
						const def = paramMap.get(name) ?? ({ name, displayName: name, type: 'string', default: '' } as AtlasModelParameter);
						const coerced = coerceValueForParameter(rawValue, def as AtlasModelParameter);
						if (coerced !== undefined && !isEmptyValue(coerced)) requestData[name] = coerced;
					}
				}

				const path = model.type === 'Video' ? '/api/v1/model/generateVideo' : '/api/v1/model/generateImage';
				const submitResponse = await atlasApiRequest(
					this,
					credentials,
					{
						method: 'POST',
						url: path,
						body: requestData,
					},
					itemIndex,
				);

				const getStringAt = (obj: unknown, keys: string[]): string | undefined => {
					let cur: unknown = obj;
					for (const key of keys) {
						if (!cur || typeof cur !== 'object' || !(key in (cur as Record<string, unknown>))) return undefined;
						cur = (cur as Record<string, unknown>)[key];
					}
					return typeof cur === 'string' ? cur : undefined;
				};

				const predictionId =
					getStringAt(submitResponse, ['data', 'id']) ??
					getStringAt(submitResponse, ['data', 'data', 'id']) ??
					getStringAt(submitResponse, ['id']) ??
					getStringAt(submitResponse, ['data', 'prediction_id']) ??
					getStringAt(submitResponse, ['data', 'predictionId']);

				if (!predictionId || typeof predictionId !== 'string') {
					throw new NodeOperationError(
						this.getNode(),
						`Unexpected submit response (missing prediction id): ${JSON.stringify(submitResponse)}`,
						{ itemIndex },
					);
				}

				let result: IDataObject = {
					prediction_id: predictionId,
					status: 'submitted',
					category,
					model_uuid: model.uuid,
					model: model.model,
					model_display_name: model.displayName,
					model_type: model.type,
					api_base_url: apiBaseUrl,
					request: requestData,
				};

				if (executionMode === 'wait') {
					const pollingOptions = this.getNodeParameter('pollingOptions', itemIndex, {}) as {
						maxWaitTime?: number;
						pollInterval?: number;
						maxRetries?: number;
					};
					const completed = await waitForPredictionCompletion(
						this,
						credentials,
						predictionId,
						{
							maxWaitMs: (pollingOptions.maxWaitTime || 15) * 60 * 1000,
							pollIntervalMs: (pollingOptions.pollInterval || 2) * 1000,
							maxRetries: pollingOptions.maxRetries || 20,
						},
						itemIndex,
					);
					if (completed && typeof completed === 'object' && !Array.isArray(completed)) {
						result = { ...result, ...(completed as IDataObject) };
					} else {
						result = { ...result, completed };
					}
				}

				returnData.push({ json: result, pairedItem: { item: itemIndex } });
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
