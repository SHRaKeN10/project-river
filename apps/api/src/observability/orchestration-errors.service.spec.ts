import { ErrorContext, ErrorReporter } from './error-reporter';
import { OrchestrationErrorsService } from './orchestration-errors.service';

class FakeReporter extends ErrorReporter {
  calls: Array<{ error: unknown; context: ErrorContext }> = [];
  capture(error: unknown, context: ErrorContext): void {
    this.calls.push({ error, context });
  }
}

describe('OrchestrationErrorsService', () => {
  let reporter: FakeReporter;
  let svc: OrchestrationErrorsService;

  beforeEach(() => {
    reporter = new FakeReporter();
    svc = new OrchestrationErrorsService(reporter);
  });

  it('starts empty', () => {
    expect(svc.snapshot()).toEqual({
      total: 0,
      byScope: {},
      lastMessage: null,
      lastAt: null,
    });
  });

  it('counts by scope and forwards to the reporter with the detail merged in', () => {
    svc.record('tournament-runner', new Error('boom'), { tournamentId: 't1' });
    svc.record('tournament-runner', new Error('bang'));
    svc.record('table-listener', 'weird string error', { tableId: 'x' });

    const snap = svc.snapshot();
    expect(snap.total).toBe(3);
    expect(snap.byScope).toEqual({ 'tournament-runner': 2, 'table-listener': 1 });
    expect(snap.lastMessage).toBe('weird string error');
    expect(snap.lastAt).toEqual(expect.any(String));

    expect(reporter.calls).toHaveLength(3);
    expect(reporter.calls[0].context).toMatchObject({
      scope: 'tournament-runner',
      tournamentId: 't1',
    });
    expect(reporter.calls[2].context).toMatchObject({ scope: 'table-listener', tableId: 'x' });
  });

  it('normalises non-Error values for lastMessage', () => {
    svc.record('x', { not: 'an error' });
    expect(svc.snapshot().lastMessage).toBe('[object Object]');
  });
});
