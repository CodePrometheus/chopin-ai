const manifest = {
  schemaVersion: 1, id: 'input-fidelity', version: '1.0.0', kind: 'plugin', runtime: 'dsh-plugin',
  intendedEffect: 'advisory', summary: 'Preserve structured inputs across isolation.', entry: 'input-fidelity.mjs',
  trigger: { taskKinds: ['verification'] },
  provides: { contexts: ['inspect-input'], tools: ['learned_echo_input'], guards: ['check-input'], skills: [], services: [], workflows: [] },
  permissions: ['system-prompt:context', 'tools:register', 'tools:guard'], dependencies: [], conflicts: [],
  requires: { chopinPluginApi: '^1.0.0', dsh: '0.1.5-rc.2' },
  lineage: { candidateIds: ['input-fidelity'], proposalIds: ['input-fidelity'] },
};

export default {
  manifest,
  activate(context) {
    context.registerTool({ name: 'learned_echo_input', description: 'Return the received data.',
      inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      async execute(execution) { return execution.environment ? { arguments: execution.arguments, environment: execution.environment } : execution.arguments; } });
    context.registerContext({ name: 'inspect-input', order: 1,
      render(input) { return input.environment ? JSON.stringify(input.environment) : Object.hasOwn(input, '__proto__') ? 'own data' : 'missing'; } });
    context.registerGuard({ name: 'check-input', tools: ['learned_echo_input', 'read'],
      evaluate(input) {
        if (input.environment && !input.environment.tools.includes(input.toolName)) return 'Undeclared tool';
        return Object.hasOwn(input.arguments, '__proto__') ? 'own data' : undefined;
      } });
  },
};
