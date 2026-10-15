import { SENTRY_RUNTIME_INSTRUMENTATIONS } from '@sentry/server-utils/orchestrion/config'

for (const instrumentation of SENTRY_RUNTIME_INSTRUMENTATIONS) {
  if (instrumentation.module.name === 'postgres')
    instrumentation.module.versionRange = '>=3.0.0 <5'
}
