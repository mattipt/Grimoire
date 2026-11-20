import {
  expandAntigravityVaultSkillInvocation,
  neutralizeAgyBuiltinSlashTokens,
} from '@/providers/antigravity/runtime/AntigravityVaultSkills';

/**
 * What `/skill` means to a provider that has no slash commands.
 *
 * `agy --print` resolves nothing: without this the CLI receives the literal
 * text `/researcher` and the agent is left to guess what was meant (#58).
 */
describe('expandAntigravityVaultSkillInvocation', () => {
  const skills = {
    listVaultEntries: async () => [
      { name: 'researcher', content: 'Read the vault and answer with citations.' },
      { name: 'empty', content: '   ' },
      {
        name: 'open',
        content: [
          'Run /plan review or /plan update?',
          'Extract to /learn — reusable lesson.',
          'Check `.agents/workflows/plan.md` and `https://example.com/plan`.',
        ].join('\n'),
      },
    ],
  };

  it('replaces the invocation with the skill body and the words after it', async () => {
    const expanded = await expandAntigravityVaultSkillInvocation(
      '/researcher what changed this week?',
      skills,
    );

    expect(expanded).toBe([
      'You are executing the vault skill "researcher". Follow its instructions.',
      '',
      'Read the vault and answer with citations.',
      '',
      'User input for this skill:',
      'what changed this week?',
    ].join('\n'));
  });

  it('keeps the context the composer appended, and never searches it', async () => {
    // `<current_note>` and its siblings are appended after the user's words. A
    // skill invocation is only ever the first thing a person typed, so the tail
    // rides along untouched — searching it would let a note's own text look
    // like an invocation.
    const expanded = await expandAntigravityVaultSkillInvocation(
      '/researcher summarize\n\n<current_note path="a.md">/researcher</current_note>',
      skills,
    );

    expect(expanded).toContain('Read the vault and answer with citations.');
    expect(expanded.endsWith('<current_note path="a.md">/researcher</current_note>')).toBe(true);
  });

  it('sends what the person typed when there is nothing to expand it into', async () => {
    // Three ways to have nothing: no such skill, a skill with an empty body,
    // and no vault to ask. None of them is a reason to fail a turn.
    await expect(expandAntigravityVaultSkillInvocation('/unknown hello', skills))
      .resolves.toBe('/unknown hello');
    await expect(expandAntigravityVaultSkillInvocation('/empty hello', skills))
      .resolves.toBe('/empty hello');
    await expect(expandAntigravityVaultSkillInvocation('/researcher hello', null))
      .resolves.toBe('/researcher hello');
    await expect(expandAntigravityVaultSkillInvocation('just a question', skills))
      .resolves.toBe('just a question');
  });

  it('sends what the person typed when the vault cannot be listed', async () => {
    const broken = { listVaultEntries: async () => { throw new Error('vault unreadable'); } };

    await expect(expandAntigravityVaultSkillInvocation('/researcher hello', broken))
      .resolves.toBe('/researcher hello');
  });

  it('neutralizes built-in agy slash tokens inside expanded vault skills while keeping arguments and context tail intact', async () => {
    const expanded = await expandAntigravityVaultSkillInvocation(
      '/open check /plan handling\n\n<excluded_folders>\n  <folder>Archive</folder>\n</excluded_folders>',
      skills,
    );

    expect(expanded).toBe([
      'You are executing the vault skill "open". Follow its instructions.',
      '',
      'Run /\u200Bplan review or /\u200Bplan update?',
      'Extract to /\u200Blearn — reusable lesson.',
      'Check `.agents/workflows/plan.md` and `https://example.com/plan`.',
      '',
      'User input for this skill:',
      'check /plan handling',
      '',
      '<excluded_folders>',
      '  <folder>Archive</folder>',
      '</excluded_folders>',
    ].join('\n'));
  });

  it('leaves unmatched built-in slash prompts unchanged without inserting zero-width spaces', async () => {
    await expect(expandAntigravityVaultSkillInvocation('/compact focus', skills))
      .resolves.toBe('/compact focus');
    await expect(expandAntigravityVaultSkillInvocation('/boost deeply', skills))
      .resolves.toBe('/boost deeply');
  });
});

describe('neutralizeAgyBuiltinSlashTokens', () => {
  it('neutralizes all built-in agy slash commands across start-of-line, prose, backticks, parentheses, and quotes', () => {
    const sample = [
      '/learn <topic-name>',
      '/plan [project]',
      'Run /plan review or /plan update?',
      'Extract to /learn — reusable lesson.',
      '`⚠️ missing file. Run /plan to fix.`',
      '`/plan create` and `/plan`',
      '(proceed to plan /plan) and "/plan dev" and \'/PLAN\'',
      'All commands: /plan /learn /goal /compact /schedule /browser /grill-me /teamwork /boost',
      'Case variants: /PLAN /Learn',
    ].join('\n');

    expect(neutralizeAgyBuiltinSlashTokens(sample)).toBe([
      '/\u200Blearn <topic-name>',
      '/\u200Bplan [project]',
      'Run /\u200Bplan review or /\u200Bplan update?',
      'Extract to /\u200Blearn — reusable lesson.',
      '`⚠️ missing file. Run /\u200Bplan to fix.`',
      '`/\u200Bplan create` and `/\u200Bplan`',
      '(proceed to plan /\u200Bplan) and "/\u200Bplan dev" and \'/\u200BPLAN\'',
      'All commands: /\u200Bplan /\u200Blearn /\u200Bgoal /\u200Bcompact /\u200Bschedule /\u200Bbrowser /\u200Bgrill-me /\u200Bteamwork /\u200Bboost',
      'Case variants: /\u200BPLAN /\u200BLearn',
    ].join('\n'));
  });

  it('preserves file paths, URLs, extended word tokens, and non-agy PARA slash commands', () => {
    const sample = [
      'Paths: .agents/workflows/plan.md and docs/plan/readme.md and /plan/subpath',
      'URL: https://example.com/plan',
      'Extended words: /planning /plan-v2 /goals /learner /boosting',
      'PARA commands: /open /end /spec /backlog /brainstorm',
    ].join('\n');

    expect(neutralizeAgyBuiltinSlashTokens(sample)).toBe(sample);
  });
});
