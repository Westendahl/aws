import * as chalk from 'chalk'
import { ComandDefinition } from './CommandDefinition'
import { createCA } from '../jitp/createCA'

export const createCACommand = ({
	stackId,
	region,
	certsDir,
}: {
	stackId: string
	region: string
	certsDir: string
}): ComandDefinition => ({
	command: 'create-ca',
	action: async () => {
		const { certificateId } = await createCA({
			stackId,
			certsDir,
			region,
			log: (...message: any[]) => {
				console.log(...message.map(m => chalk.magenta(m)))
			},
			debug: (...message: any[]) => {
				console.log(...message.map(m => chalk.cyan(m)))
			},
		})
		console.log(
			chalk.green(`CA certificate ${chalk.yellow(certificateId)} registered.`),
		)
		console.log(chalk.green('You can now generate device certificates.'))
	},
	help:
		'Creates a CA certificate and registers it for Just-in-time provisioning.',
})
