import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { extractPredictionData, getPrediction, waitForPredictionCompletion, type AtlasCloudApiCredentials } from '../../utils/AtlasCloudClient';

export class AtlasCloudTaskStatus implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'AtlasCloud Task Status',
		name: 'atlasCloudTaskStatus',
		icon: 'file:AtlasCloudTaskStatus.svg',
		group: ['input'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Get status for an AtlasCloud image/video prediction, or wait for completion',
		documentationUrl: 'https://www.atlascloud.ai/docs',
		defaults: { name: 'AtlasCloud Task Status' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: 'atlasCloudApi', required: true }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Get Status', value: 'getStatus', action: 'Get prediction status' },
					{ name: 'Wait for Completion', value: 'waitForCompletion', action: 'Wait for prediction completion' },
				],
				default: 'getStatus',
			},
			{
				displayName: 'Prediction ID',
				name: 'predictionId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { operation: ['getStatus', 'waitForCompletion'] } },
			},
			{
				displayName: 'Polling Options',
				name: 'pollingOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { operation: ['waitForCompletion'] } },
				options: [
					{ displayName: 'Max Wait Time (Minutes)', name: 'maxWaitTime', type: 'number', default: 15 },
					{ displayName: 'Poll Interval (Seconds)', name: 'pollInterval', type: 'number', default: 2 },
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

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const predictionId = this.getNodeParameter('predictionId', itemIndex) as string;
				const credentials = (await this.getCredentials('atlasCloudApi')) as unknown as AtlasCloudApiCredentials;

				if (operation === 'getStatus') {
					const payload = await getPrediction(this, credentials, predictionId, itemIndex);
					const { status, data } = extractPredictionData(payload);
					const dataObj =
						data && typeof data === 'object' && !Array.isArray(data) ? (data as IDataObject) : ({ data } as IDataObject);
					returnData.push({
						json: { prediction_id: predictionId, status, ...dataObj, raw: payload },
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				if (operation === 'waitForCompletion') {
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
					const completedObj =
						completed && typeof completed === 'object' && !Array.isArray(completed)
							? (completed as IDataObject)
							: ({ completed } as IDataObject);
					returnData.push({ json: { prediction_id: predictionId, ...completedObj }, pairedItem: { item: itemIndex } });
					continue;
				}

				throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`, { itemIndex });
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
