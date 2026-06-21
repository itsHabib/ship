/** Re-export fake runner under the cursor-runner test subpath for harness compat. */
export { FakeAgentRunner as FakeCursorRunner, FakeAgentRunner } from "@ship/agent-runner/test/fake";
export type {
  FakeAgentAttachCall as FakeCursorAttachCall,
  FakeAgentAttachScript as FakeCursorAttachScript,
  FakeAgentRunCall as FakeCursorRunCall,
  FakeAgentRunnerOptions as FakeCursorRunnerOptions,
  FakeAgentScript as FakeCursorScript,
  FakeAgentAttachCall,
  FakeAgentAttachScript,
  FakeAgentRunCall,
  FakeAgentRunnerOptions,
  FakeAgentScript,
} from "@ship/agent-runner/test/fake";
