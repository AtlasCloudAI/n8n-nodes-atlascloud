import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
	Icon,
} from 'n8n-workflow';

import { ATLASCLOUD_DEFAULT_API_BASE_URL } from '../utils/AtlasCloudClient';

export class AtlasCloudApi implements ICredentialType {
	name = 'atlasCloudApi';

	displayName = 'AtlasCloud API';

	icon: Icon = 'file:AtlasCloud.svg';

	documentationUrl = 'https://www.atlascloud.ai/docs';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description: 'Create an API key in https://console.atlascloud.ai/settings',
		},
		{
			displayName: 'API Base URL',
			name: 'apiBaseUrl',
			type: 'hidden',
			default: ATLASCLOUD_DEFAULT_API_BASE_URL,
			description:
				'Base URL for generation + OpenAI-compatible endpoints (default: https://api.atlascloud.ai)',
		},
		{
			displayName: 'Console Base URL',
			name: 'consoleBaseUrl',
			type: 'hidden',
			default: 'https://console.atlascloud.ai',
			description: 'Used to fetch model list and metadata (default: https://console.atlascloud.ai)',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.apiBaseUrl}}',
			url: '/v1/models',
		},
	};
}
