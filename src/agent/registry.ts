import type { AgentProvider, AgentProviderId } from './types'
import { RcodeRuntimeProvider } from '../rcode/rcode-runtime'

export function getProvider(_id: AgentProviderId): AgentProvider {
  return new RcodeRuntimeProvider()
}
