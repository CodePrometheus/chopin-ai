const manifest = {
  schemaVersion: 1, id: 'dispatch-procedure', version: '1.0.0', kind: 'plugin', runtime: 'dsh-plugin',
  intendedEffect: 'advisory', summary: 'Exercise bounded native tool composition.', entry: 'dispatch-procedure.mjs',
  trigger: { taskKinds: ['verification'] },
  provides: { contexts: [], tools: ['learned_procedure'], guards: [], skills: [], services: [], workflows: [] },
  permissions: ['tools:register', 'tools:dispatch'], dependencies: [], conflicts: [],
  requires: { chopinPluginApi: '^1.1.0', dsh: '0.1.5-rc.2' }, lineage: { candidateIds: ['dispatch-procedure'], proposalIds: ['dispatch-procedure'] },
};
export default { manifest, activate(context) {
  context.registerTool({ name: 'learned_procedure', description: 'Read, update and check through authorized tools.',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    dispatch: { tools: ['read', 'write', 'project_check'], maxSteps: 3 },
    async execute({ arguments: input, steps = [] }) {
      if (input.operation) return { kind: 'call', tool: input.operation, arguments: {} };
      if (input.loop || steps.length === 0) return { kind: 'call', tool: 'read', arguments: { file_path: 'input.txt' } };
      if (steps.length === 1) return { kind: 'call', tool: 'write', arguments: { content: steps[0].value.content + ':checked' } };
      if (steps.length === 2) return { kind: 'call', tool: 'project_check', arguments: { finish: true } };
      return { kind: 'done', value: {} };
    },
  });
} };
