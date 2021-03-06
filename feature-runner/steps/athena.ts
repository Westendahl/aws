import { regexMatcher } from '@coderbyheart/bdd-feature-runner-aws'
import { BifravstWorld } from '../run-features'
import { athenaQuery, parseAthenaResult } from '@bifravst/athena-helpers'
import { Athena } from 'aws-sdk'
import { exponential } from 'backoff'

export const athenaStepRunners = ({
	region,
	historicaldataWorkgroupName,
}: {
	region: string
	historicaldataWorkgroupName: string
}) => [
	regexMatcher<BifravstWorld>(
		/^I run this query in the Athena workgroup ([^ ]+)$/,
	)(async (_, step, runner) => {
		if (!step.interpolatedArgument) {
			throw new Error('Must provide argument!')
		}
		const athena = new Athena({
			region,
		})
		const q = athenaQuery({
			WorkGroup: historicaldataWorkgroupName,
			athena,
			debugLog: async (...args: any) => {
				await runner.progress('[athena:debug]', JSON.stringify(args))
			},
			errorLog: async (...args: any) => {
				await runner.progress('[athena:error]', JSON.stringify(args))
			},
			backoff: (() => {
				const b = exponential({
					randomisationFactor: 0,
					initialDelay: 1000,
					maxDelay: 5000,
				})
				b.failAfter(14) // 62000
				return b
			})(),
		})
		await runner.progress('[athena]', step.interpolatedArgument)
		const ResultSet = await q({ QueryString: step.interpolatedArgument })
		const data = parseAthenaResult({
			ResultSet,
			skip: 1,
		})
		// eslint-disable-next-line require-atomic-updates
		runner.store['athenaQueryResult'] = data
		return data
	}),
]
