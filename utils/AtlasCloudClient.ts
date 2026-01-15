import type { GenericValue, IDataObject, IExecuteFunctions, ILoadOptionsFunctions } from 'n8n-workflow';
import { NodeOperationError, sleep } from 'n8n-workflow';

export const ATLASCLOUD_DEFAULT_API_BASE_URL = 'https://api.atlascloud.ai';
export const ATLASCLOUD_DEFAULT_CONSOLE_BASE_URL = 'https://console.atlascloud.ai';

export type AtlasCloudContext = IExecuteFunctions | ILoadOptionsFunctions;
export type AtlasModelType = 'Image' | 'Video' | 'Text' | string;

export interface AtlasCloudModel {
	uuid: string;
	model: string;
	type: AtlasModelType;
	displayName: string;
	profile?: string;
	categories?: string[];
	tags?: string[];
	schema?: string;
	example?: string;
	readme?: string;
}

export interface AtlasCloudModelsResponse {
	code?: string | number;
	data?: unknown[];
}

export interface AtlasJsonSchema {
	properties?: Record<string, unknown>;
	required?: string[];
	[x: string]: unknown;
}

export interface AtlasModelParameter {
	name: string;
	displayName: string;
	type: 'string' | 'number' | 'boolean' | 'options' | 'collection';
	required: boolean;
	default?: unknown;
	description?: string;
	options?: Array<{ name: string; value: string | number | boolean; description?: string }>;
	typeOptions?: Record<string, unknown>;
}

export interface AtlasCloudApiCredentials {
	apiKey: string;
	apiBaseUrl?: string;
	consoleBaseUrl?: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedModels: { fetchedAt: number; models: AtlasCloudModel[] } | null = null;
const cachedSchemaByUrl = new Map<string, { fetchedAt: number; schema: AtlasJsonSchema }>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCode(code: unknown): string {
	if (typeof code === 'number') return String(code);
	if (typeof code === 'string') return code;
	return '';
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
}

export function getApiBaseUrl(credentials: AtlasCloudApiCredentials): string {
	return (credentials.apiBaseUrl || ATLASCLOUD_DEFAULT_API_BASE_URL).replace(/\/+$/, '');
}

export function getConsoleBaseUrl(credentials: AtlasCloudApiCredentials): string {
	return (credentials.consoleBaseUrl || ATLASCLOUD_DEFAULT_CONSOLE_BASE_URL).replace(/\/+$/, '');
}

export function formatCategoryName(category: string): string {
	return category
		.replace(/_/g, '-')
		.split('-')
		.map((word) => (word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word))
		.join(' ');
}

export async function fetchAtlasModels(context: AtlasCloudContext): Promise<AtlasCloudModel[]> {
	const now = Date.now();
	if (cachedModels && now - cachedModels.fetchedAt < CACHE_TTL_MS) {
		return cachedModels.models;
	}

	const credentials = (await context.getCredentials?.('atlasCloudApi').catch(() => undefined)) as
		| { consoleBaseUrl?: string }
		| undefined;
	const baseUrl = (credentials?.consoleBaseUrl || ATLASCLOUD_DEFAULT_CONSOLE_BASE_URL).replace(/\/+$/, '');

	const response = (await context.helpers.httpRequest({
		method: 'GET',
		url: `${baseUrl}/api/v1/models`,
		json: true,
	})) as AtlasCloudModelsResponse;

	const code = normalizeCode(response?.code);
	if (code !== '200') {
		cachedModels = { fetchedAt: now, models: [] };
		return [];
	}

	const rawModels = Array.isArray(response.data) ? response.data : [];
	const models: AtlasCloudModel[] = [];
	for (const m of rawModels) {
		if (!m || typeof m !== 'object') continue;
		const obj = m as Record<string, unknown>;
		const uuid = typeof obj.uuid === 'string' ? obj.uuid.trim() : String(obj.uuid ?? '').trim();
		const model = typeof obj.model === 'string' ? obj.model.trim() : String(obj.model ?? '').trim();
		if (!uuid || !model) continue;

		const type = typeof obj.type === 'string' ? obj.type.trim() : String(obj.type ?? '').trim();
		const displayName =
			typeof obj.displayName === 'string'
				? obj.displayName.trim()
				: typeof obj.model === 'string'
					? obj.model.trim()
					: uuid;

		const out: AtlasCloudModel = {
			uuid,
			model,
			type,
			displayName,
			categories: normalizeStringArray(obj.categories),
			tags: normalizeStringArray(obj.tags),
			schema: typeof obj.schema === 'string' ? obj.schema : undefined,
			example: typeof obj.example === 'string' ? obj.example : undefined,
			readme: typeof obj.readme === 'string' ? obj.readme : undefined,
		};
		if (typeof obj.profile === 'string' && obj.profile.trim()) out.profile = obj.profile;

		models.push(out);
	}

	cachedModels = { fetchedAt: now, models };
	return models;
}

export function modelMatchesCategory(model: AtlasCloudModel, category: string): boolean {
	if (!category) return true;
	const categories = model.categories || [];
	return categories.includes(category);
}

export function modelMatchesType(model: AtlasCloudModel, modelType: string): boolean {
	if (!modelType) return true;
	return String(model.type) === modelType;
}

export async function fetchSchemaByUrl(context: AtlasCloudContext, schemaUrl: string): Promise<AtlasJsonSchema> {
	const url = (schemaUrl || '').trim();
	if (!url) return {};

	const now = Date.now();
	const cached = cachedSchemaByUrl.get(url);
	if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.schema;

	const schema = (await context.helpers.httpRequest({
		method: 'GET',
		url,
		json: true,
	})) as AtlasJsonSchema;

	cachedSchemaByUrl.set(url, { fetchedAt: now, schema: schema || {} });
	return schema || {};
}

function decodeJsonPointerSegment(segment: string): string {
	return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveJsonPointer(root: unknown, pointer: string): unknown {
	if (!pointer.startsWith('#/')) return undefined;
	const segments = pointer
		.slice(2)
		.split('/')
		.map((s) => decodeJsonPointerSegment(s));
	let current: unknown = root;
	for (const segment of segments) {
		if (!isRecord(current)) return undefined;
		current = current[segment];
	}
	return current;
}

function resolveLocalRef(root: unknown, schema: unknown, seen: Set<string> = new Set()): unknown {
	if (!isRecord(schema)) return schema;
	const ref = schema.$ref;
	if (typeof ref !== 'string') return schema;
	if (seen.has(ref)) return schema;
	seen.add(ref);
	const resolved = resolveJsonPointer(root, ref);
	return resolveLocalRef(root, resolved, seen);
}

function extractInputSchemaFromOpenApi(openApiDoc: AtlasJsonSchema): AtlasJsonSchema | undefined {
	if (!isRecord(openApiDoc)) return undefined;
	if (typeof openApiDoc.openapi !== 'string') return undefined;

	const components = isRecord(openApiDoc.components) ? openApiDoc.components : undefined;
	const schemas = components && isRecord(components.schemas) ? components.schemas : undefined;
	if (schemas) {
		const input = resolveLocalRef(openApiDoc, schemas.Input);
		if (isRecord(input)) return input as AtlasJsonSchema;
	}

	const paths = isRecord(openApiDoc.paths) ? openApiDoc.paths : undefined;
	if (!paths) return undefined;

	for (const pathItem of Object.values(paths)) {
		if (!isRecord(pathItem)) continue;
		for (const operation of Object.values(pathItem)) {
			if (!isRecord(operation)) continue;
			const requestBody = isRecord(operation.requestBody) ? operation.requestBody : undefined;
			if (!requestBody) continue;
			const content = isRecord(requestBody.content) ? requestBody.content : undefined;
			if (!content) continue;
			const appJson = isRecord(content['application/json']) ? content['application/json'] : undefined;
			const schema = appJson ? appJson.schema : undefined;
			const resolved = resolveLocalRef(openApiDoc, schema);
			if (isRecord(resolved)) return resolved as AtlasJsonSchema;
		}
	}

	return undefined;
}

function normalizeToInputSchema(schemaDoc: AtlasJsonSchema): { input: AtlasJsonSchema; root: AtlasJsonSchema } {
	const fromOpenApi = extractInputSchemaFromOpenApi(schemaDoc);
	if (fromOpenApi) return { input: fromOpenApi, root: schemaDoc };
	return { input: schemaDoc, root: schemaDoc };
}

export function parseJsonSchemaToParameters(schemaDoc: AtlasJsonSchema): AtlasModelParameter[] {
	const { input: inputSchema, root } = normalizeToInputSchema(schemaDoc);
	if (!inputSchema || !isRecord(inputSchema) || !inputSchema.properties) return [];

	const properties = inputSchema.properties || {};
	const requiredList = Array.isArray(inputSchema.required) ? inputSchema.required : [];
	const orderProp = (inputSchema as Record<string, unknown>)['x-order-properties'];
	const order = Array.isArray(orderProp) ? (orderProp.filter((v) => typeof v === 'string') as string[]) : Object.keys(properties);

	const parameters: AtlasModelParameter[] = [];

	for (const propName of order) {
		const prop = resolveLocalRef(root, properties[propName]);
		if (!isRecord(prop)) continue;
		const propObj = prop as Record<string, unknown>;
		if (propObj.hidden === true || propObj.disabled === true) continue;

		const required = requiredList.includes(propName);
		const description = typeof propObj.description === 'string' ? propObj.description : undefined;

		let type: AtlasModelParameter['type'] = 'string';
		const enumValues = Array.isArray(propObj.enum) ? propObj.enum : [];
		const propType = typeof propObj.type === 'string' ? propObj.type : undefined;
		if (enumValues.length > 0) {
			type = 'options';
		} else if (propType === 'boolean') {
			type = 'boolean';
		} else if (propType === 'number' || propType === 'integer') {
			type = 'number';
		} else if (propType === 'array' || propType === 'object') {
			type = 'collection';
		} else {
			type = 'string';
		}

		const parameter: AtlasModelParameter = {
			name: propName,
			displayName:
				typeof propObj.title === 'string' && propObj.title.trim()
					? propObj.title.trim()
					: propName
							.split('_')
							.map((w: string) => (w ? w[0].toUpperCase() + w.slice(1) : w))
							.join(' '),
			type,
			required,
			default: propObj.default,
			description,
		};

		if (type === 'options') {
			parameter.options = enumValues.map((v) => {
				const value: string | number | boolean =
					typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : JSON.stringify(v);
				return {
					name: typeof v === 'string' ? v : String(value),
					value,
					description: typeof v === 'string' ? v : String(value),
				};
			});
			if (parameter.default !== undefined && !enumValues.includes(parameter.default)) {
				parameter.default = enumValues[0];
			}
		}

		if (type === 'number') {
			const typeOptions: Record<string, unknown> = {
				numberPrecision: propType === 'integer' ? 0 : 2,
			};
			if (propObj.minimum !== undefined) typeOptions.minValue = propObj.minimum;
			if (propObj.maximum !== undefined) typeOptions.maxValue = propObj.maximum;
			parameter.typeOptions = typeOptions;
		}

		parameters.push(parameter);
	}

	return parameters;
}

export function isEmptyValue(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	if (typeof value === 'string') return value.trim() === '';
	if (Array.isArray(value)) return value.length === 0;
	if (typeof value === 'object' && value.constructor === Object) return Object.keys(value as Record<string, unknown>).length === 0;
	return false;
}

export function coerceValueForParameter(value: unknown, parameter: AtlasModelParameter): GenericValue {
	if (isEmptyValue(value)) return undefined;

	if (parameter.type === 'boolean') {
		if (typeof value === 'boolean') return value;
		if (typeof value === 'number') return value !== 0;
		if (typeof value === 'string') {
			const v = value.trim().toLowerCase();
			if (v === 'true') return true;
			if (v === 'false') return false;
		}
		return Boolean(value);
	}

	if (parameter.type === 'number') {
		if (typeof value === 'number') return value;
		const str = typeof value === 'string' ? value.trim() : String(value);
		if (!str) return undefined;
		const n = Number(str);
		if (Number.isNaN(n)) return str;
		return n;
	}

	if (parameter.type === 'collection') {
		if (typeof value === 'object') return value as GenericValue;
		if (typeof value === 'string') {
			const str = value.trim();
			if (!str) return undefined;
			if ((str.startsWith('{') && str.endsWith('}')) || (str.startsWith('[') && str.endsWith(']'))) {
				try {
					return JSON.parse(str) as GenericValue;
				} catch {
					return value;
				}
			}
		}
		return value as GenericValue;
	}

	if (parameter.type === 'options') {
		if (!parameter.options || parameter.options.length === 0) return value as GenericValue;
		const match = parameter.options.find((o) => o.value === value || o.name === value);
		return match ? match.value : (value as GenericValue);
	}

	return value as GenericValue;
}

export async function atlasApiRequest(
	context: IExecuteFunctions,
	credentials: AtlasCloudApiCredentials,
	options: {
		method: 'GET' | 'POST';
		url: string;
		body?: IDataObject;
		qs?: IDataObject;
	},
	itemIndex?: number,
): Promise<IDataObject> {
	const apiBaseUrl = getApiBaseUrl(credentials);
	const url = options.url.startsWith('http') ? options.url : `${apiBaseUrl}${options.url}`;

	try {
		const response = await context.helpers.httpRequest({
			method: options.method,
			url,
			json: true,
			headers: {
				Authorization: `Bearer ${credentials.apiKey}`,
				'Content-Type': 'application/json',
				'X-Atlas-Client': 'n8n',
				'X-Atlas-Source': 'n8n-community-node',
			},
			body: options.body,
			qs: options.qs,
		});
		if (response && typeof response === 'object' && !Array.isArray(response)) {
			return response as IDataObject;
		}
		return { data: response } as IDataObject;
	} catch (error) {
		throw new NodeOperationError(context.getNode(), error as Error, { itemIndex });
	}
}

export async function getPrediction(
	context: IExecuteFunctions,
	credentials: AtlasCloudApiCredentials,
	predictionId: string,
	itemIndex?: number,
): Promise<IDataObject> {
	if (!predictionId?.trim()) {
		throw new NodeOperationError(context.getNode(), 'Prediction ID is required', { itemIndex });
	}

	return await atlasApiRequest(
		context,
		credentials,
		{
			method: 'GET',
			url: `/api/v1/model/prediction/${predictionId}`,
		},
		itemIndex,
	);
}

type PredictionStatus = 'created' | 'pending' | 'processing' | 'running' | 'completed' | 'succeeded' | 'failed' | string;

export function extractPredictionData(payload: IDataObject): { status?: PredictionStatus; data?: IDataObject } {
	const data = payload.data;
	if (data && typeof data === 'object' && !Array.isArray(data)) {
		const status = (data as IDataObject).status as PredictionStatus | undefined;
		return { status, data: data as IDataObject };
	}
	if (payload.status) {
		return { status: payload.status as PredictionStatus, data: payload };
	}
	return { data: payload };
}

export async function waitForPredictionCompletion(
	context: IExecuteFunctions,
	credentials: AtlasCloudApiCredentials,
	predictionId: string,
	options: { maxWaitMs: number; pollIntervalMs: number; maxRetries: number },
	itemIndex?: number,
): Promise<IDataObject> {
	const start = Date.now();
	let consecutiveErrors = 0;

	while (Date.now() - start < options.maxWaitMs) {
		try {
			const payload = await getPrediction(context, credentials, predictionId, itemIndex);
			const { status, data } = extractPredictionData(payload);
			consecutiveErrors = 0;

			if (status === 'completed' || status === 'succeeded') return data ?? payload;
			if (status === 'failed') {
				const err = typeof data?.error === 'string' ? data.error : 'Generation failed';
				throw new NodeOperationError(context.getNode(), err, { itemIndex });
			}
		} catch (error) {
			consecutiveErrors += 1;
			if (consecutiveErrors >= options.maxRetries) {
				throw new NodeOperationError(
					context.getNode(),
					`Failed to check prediction status after ${options.maxRetries} retries: ${
						error instanceof Error ? error.message : String(error)
					}`,
					{ itemIndex },
				);
			}
		}

		await sleep(options.pollIntervalMs);
	}

	throw new NodeOperationError(
		context.getNode(),
		`Timed out waiting for prediction ${predictionId} after ${Math.round(options.maxWaitMs / 1000)}s`,
		{ itemIndex },
	);
}
