import * as CloudFormation from '@aws-cdk/core'
import * as S3 from '@aws-cdk/aws-s3'
import * as IAM from '@aws-cdk/aws-iam'
import * as IoT from '@aws-cdk/aws-iot'
import * as Events from '@aws-cdk/aws-events'
import * as EventTargets from '@aws-cdk/aws-events-targets'
import * as Lambda from '@aws-cdk/aws-lambda'
import { LayeredLambdas } from '@bifravst/package-layered-lambdas'
import { logToCloudWatch } from './logToCloudWatch'
import { LambdaLogGroup } from './LambdaLogGroup'
import { BifravstLambdas } from '../prepare-resources'

/**
 * Provides resources for historical data
 */
export class HistoricalData extends CloudFormation.Resource {
	public readonly bucket: S3.IBucket
	public readonly queryResultsBucket: S3.IBucket
	public constructor(
		parent: CloudFormation.Stack,
		id: string,
		{
			sourceCodeBucket,
			baseLayer,
			lambdas,
			userRole,
			isTest,
		}: {
			sourceCodeBucket: S3.IBucket
			baseLayer: Lambda.ILayerVersion
			lambdas: LayeredLambdas<BifravstLambdas>
			userRole: IAM.IRole
			isTest: boolean
		},
	) {
		super(parent, id)

		this.bucket = new S3.Bucket(this, 'bucket', {
			removalPolicy: isTest
				? CloudFormation.RemovalPolicy.DESTROY
				: CloudFormation.RemovalPolicy.RETAIN,
		})

		this.queryResultsBucket = new S3.Bucket(this, 'queryResults', {
			removalPolicy: CloudFormation.RemovalPolicy.DESTROY,
		})

		const writeToResultBucket = new IAM.PolicyStatement({
			resources: [
				this.queryResultsBucket.bucketArn,
				`${this.queryResultsBucket.bucketArn}/*`,
			],
			actions: [
				's3:GetBucketLocation',
				's3:GetObject',
				's3:ListBucket',
				's3:ListBucketMultipartUploads',
				's3:ListMultipartUploadParts',
				's3:AbortMultipartUpload',
				's3:PutObject',
			],
		})

		userRole.addToPolicy(
			new IAM.PolicyStatement({
				resources: ['*'],
				actions: [
					'athena:startQueryExecution',
					'athena:stopQueryExecution',
					'athena:getQueryExecution',
					'athena:getQueryResults',
					'glue:GetTable',
					'glue:GetDatabase',
				],
			}),
		)

		// Users need to read from data bucket
		userRole.addToPolicy(
			new IAM.PolicyStatement({
				resources: [this.bucket.bucketArn, `${this.bucket.bucketArn}/*`],
				actions: [
					's3:GetBucketLocation',
					's3:GetObject',
					's3:ListBucket',
					's3:ListBucketMultipartUploads',
					's3:ListMultipartUploadParts',
				],
			}),
		)

		// Users need to be able to write to the results bucket
		userRole.addToPolicy(
			new IAM.PolicyStatement({
				resources: [
					this.queryResultsBucket.bucketArn,
					`${this.queryResultsBucket.bucketArn}/*`,
				],
				actions: [
					's3:GetBucketLocation',
					's3:GetObject',
					's3:ListBucket',
					's3:ListBucketMultipartUploads',
					's3:ListMultipartUploadParts',
					's3:AbortMultipartUpload',
					's3:PutObject',
				],
			}),
		)

		userRole.addToPolicy(
			new IAM.PolicyStatement({
				resources: [this.bucket.bucketArn, `${this.bucket.bucketArn}/*`],
				actions: ['s3:GetBucketLocation', 's3:GetObject', 's3:ListBucket'],
			}),
		)

		userRole.addToPolicy(writeToResultBucket)

		const topicRuleRole = new IAM.Role(this, 'Role', {
			assumedBy: new IAM.ServicePrincipal('iot.amazonaws.com'),
			inlinePolicies: {
				rootPermissions: new IAM.PolicyDocument({
					statements: [
						new IAM.PolicyStatement({
							actions: ['s3:PutObject'],
							resources: [`${this.bucket.bucketArn}/*`],
						}),
						new IAM.PolicyStatement({
							actions: ['iot:Publish'],
							resources: [
								`arn:aws:iot:${parent.region}:${parent.account}:topic/errors`,
							],
						}),
					],
				}),
			},
		})

		new IoT.CfnTopicRule(this, 'storeUpdates', {
			topicRulePayload: {
				awsIotSqlVersion: '2016-03-23',
				description: 'Store all updates to thing shadow documents on S3',
				ruleDisabled: false,
				// Note: this timestamp is formatted for the AWS Athena TIMESTAMP datatype
				sql:
					'SELECT state.reported AS reported, parse_time("yyyy-MM-dd HH:mm:ss.S", timestamp()) as timestamp, clientid() as deviceId FROM \'$aws/things/+/shadow/update\'',
				actions: [
					{
						s3: {
							bucketName: this.bucket.bucketName,
							key:
								'updates/raw/${parse_time("yyyy/MM/dd", timestamp())}/${parse_time("yyyyMMdd\'T\'HHmmss", timestamp())}-${clientid()}-${newuuid()}.json',
							roleArn: topicRuleRole.roleArn,
						},
					},
				],
				errorAction: {
					republish: {
						roleArn: topicRuleRole.roleArn,
						topic: 'errors',
					},
				},
			},
		})

		new IoT.CfnTopicRule(this, 'storeDocuments', {
			topicRulePayload: {
				awsIotSqlVersion: '2016-03-23',
				description: 'Store all updated thing shadow documents on S3',
				ruleDisabled: false,
				// Note: this timestamp is formatted for the AWS Athena TIMESTAMP datatype
				sql:
					'SELECT current.state.reported AS reported, parse_time("yyyy-MM-dd HH:mm:ss.S", timestamp()) as timestamp, clientid() as deviceId FROM \'$aws/things/+/shadow/update/documents\'',
				actions: [
					{
						s3: {
							bucketName: this.bucket.bucketName,
							key:
								'documents/raw/${parse_time("yyyy/MM/dd", timestamp())}/${parse_time("yyyyMMdd\'T\'HHmmss", timestamp())}-${clientid()}-${newuuid()}.json',
							roleArn: topicRuleRole.roleArn,
						},
					},
				],
				errorAction: {
					republish: {
						roleArn: topicRuleRole.roleArn,
						topic: 'errors',
					},
				},
			},
		})

		// Batch messages

		const processBatchMessagesFunction = new Lambda.Function(
			this,
			'processBatchMessagesLambda',
			{
				layers: [baseLayer],
				handler: 'index.handler',
				runtime: Lambda.Runtime.NODEJS_10_X,
				timeout: CloudFormation.Duration.seconds(10),
				memorySize: 1792,
				code: Lambda.Code.bucket(
					sourceCodeBucket,
					lambdas.lambdaZipFileNames.processBatchMessages,
				),
				description: 'Processes batch messages and stores them on S3',
				initialPolicy: [
					logToCloudWatch,
					new IAM.PolicyStatement({
						resources: [this.bucket.bucketArn, `${this.bucket.bucketArn}/*`],
						actions: [
							's3:ListBucket',
							's3:GetObject',
							's3:PutObject',
							's3:DeleteObject',
						],
					}),
				],
				environment: {
					HISTORICAL_DATA_BUCKET: this.bucket.bucketName,
				},
				reservedConcurrentExecutions: 1
			},
		)

		new LambdaLogGroup(this, 'processBatchMessagesFunctionLogGroup', {
			lambda: processBatchMessagesFunction,
		})

		const processBatchMessagesRule = new IoT.CfnTopicRule(
			this,
			'processBatchMessagesIotRule',
			{
				topicRulePayload: {
					awsIotSqlVersion: '2016-03-23',
					description: 'Processes all batch messages and stores them on S3',
					ruleDisabled: false,
					sql:
						"SELECT * as message, clientid() as deviceId, newuuid() as messageId, timestamp() as timestamp FROM '+/batch'",
					actions: [
						{
							lambda: {
								functionArn: processBatchMessagesFunction.functionArn,
							},
						},
					],
					errorAction: {
						republish: {
							roleArn: topicRuleRole.roleArn,
							topic: 'errors',
						},
					},
				},
			},
		)

		processBatchMessagesFunction.addPermission(
			'processBatchMessagesInvokeByIot',
			{
				principal: new IAM.ServicePrincipal('iot.amazonaws.com'),
				sourceArn: processBatchMessagesRule.attrArn,
			},
		)

		// Concatenate the log files

		const concatenateRawDeviceMessagesFunction = new Lambda.Function(
			this,
			'concatenateRawDeviceMessages',
			{
				layers: [baseLayer],
				handler: 'index.handler',
				runtime: Lambda.Runtime.NODEJS_10_X,
				timeout: CloudFormation.Duration.seconds(900),
				memorySize: 1792,
				code: Lambda.Code.bucket(
					sourceCodeBucket,
					lambdas.lambdaZipFileNames.concatenateRawDeviceMessages,
				),
				description:
					'Runs every hour and concatenates the raw device messages so it is more performant for Athena to query them.',
				initialPolicy: [
					logToCloudWatch,
					new IAM.PolicyStatement({
						resources: [this.bucket.bucketArn, `${this.bucket.bucketArn}/*`],
						actions: [
							's3:ListBucket',
							's3:GetObject',
							's3:PutObject',
							's3:DeleteObject',
						],
					}),
				],
				environment: {
					HISTORICAL_DATA_BUCKET: this.bucket.bucketName,
				},
			},
		)

		new LambdaLogGroup(this, 'concatenateRawDeviceMessagesFunctionLogGroup', {
			lambda: concatenateRawDeviceMessagesFunction,
		})

		const rule = new Events.Rule(this, 'invokeMessageCounterRule', {
			schedule: Events.Schedule.expression('rate(1 hour)'),
			description:
				'Invoke the lambda which concatenates the raw device messages',
			enabled: true,
			targets: [
				new EventTargets.LambdaFunction(concatenateRawDeviceMessagesFunction),
			],
		})

		concatenateRawDeviceMessagesFunction.addPermission('InvokeByEvents', {
			principal: new IAM.ServicePrincipal('events.amazonaws.com'),
			sourceArn: rule.ruleArn,
		})
	}
}
