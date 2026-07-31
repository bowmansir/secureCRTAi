import * as api from "../api";
import {
  AgentChannelRegistry,
} from "./channelRegistry.ts";

export const agentChannels = new AgentChannelRegistry({
  open: api.agentOpen,
  run: api.agentRun,
  interrupt: api.agentInterrupt,
  close: api.agentClose,
});
