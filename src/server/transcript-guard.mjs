// Pinned JSONL provider composition. Failed mutations cannot be blindly replayed
// when the provider may have failed to restore the pre-append file size.
const guardedProviders = new WeakMap();
const failuresKey = Symbol('rp-transcript-mutation-failures');
const observersKey = Symbol('rp-transcript-failure-observers');
const journalsKey = Symbol('rp-transcript-mutation-journals');

export function guardJsonlProvider(Provider) {
  if (guardedProviders.has(Provider)) return guardedProviders.get(Provider);
  for (const method of ['persistBatch', 'persistHeader', 'truncateTornTail']) {
    if (typeof Provider.prototype[method] !== 'function') throw new Error('Unsupported JSONL mutation interface: ' + method);
  }
  class GuardedJsonlProvider extends Provider {
    constructor(...args) {
      super(...args);
      // Cordis calls service methods through context-bound proxies. Symbol
      // properties survive those views; JavaScript private fields do not.
      this[failuresKey] = new Map();
      this[observersKey] = new Set();
      this[journalsKey] = new Set();
    }

    mutationFailure(sessionId) { return this[failuresKey].get(sessionId); }

    onMutationFailure(observer) {
      if (typeof observer !== 'function') throw new TypeError('Mutation failure observer must be a function');
      this[observersKey].add(observer);
      return () => this[observersKey].delete(observer);
    }

    onMutationJournal(journal) {
      if (typeof journal?.begin !== 'function' || typeof journal?.finish !== 'function')
        throw new TypeError('Mutation journal must provide synchronous begin and finish');
      this[journalsKey].add(journal);
      return () => this[journalsKey].delete(journal);
    }

    async guardedMutation(sessionId, operation, write) {
      const previous = this[failuresKey].get(sessionId);
      if (previous) throw previous.cause;
      const tickets = [];
      try {
        for (const journal of [...this[journalsKey]]) {
          const ticket = journal.begin(sessionId, operation);
          if (ticket !== undefined) tickets.push({ journal, ticket });
        }
      } catch (cause) {
        this[failuresKey].set(sessionId, { operation, cause, phase: 'intent-begin' });
        throw cause;
      }
      let result;
      try { result = await write(); }
      catch (cause) {
        if (!this[failuresKey].has(sessionId)) {
          const failure = { operation, cause, phase: 'write' };
          this[failuresKey].set(sessionId, failure);
          // Owner persistence is synchronous and completes before native error
          // events or another checkpoint can observe the rejected mutation.
          const observerErrors = [];
          for (const observe of this[observersKey]) {
            try { observe(sessionId, failure); } catch (error) { observerErrors.push(error); }
          }
          if (observerErrors.length) throw new AggregateError([cause, ...observerErrors], 'Transcript failure registration failed');
        }
        throw cause;
      }
      // An acknowledgement failure here leaves the native writer's cursor
      // unadvanced even when the physical write succeeded. Latch separately
      // and never classify it as a failed native mutation or replay the batch.
      const finishErrors = [];
      for (const { journal, ticket } of tickets) {
        try { journal.finish(sessionId, operation, ticket); } catch (error) { finishErrors.push(error); }
      }
      if (finishErrors.length) {
        const cause = finishErrors.length === 1 ? finishErrors[0] : new AggregateError(finishErrors, 'Transcript journal completion failed');
        this[failuresKey].set(sessionId, { operation, cause, phase: 'intent-finish' });
        throw cause;
      }
      return result;
    }

    persistBatch(header, events, materialized, inheritedEventCount) {
      return this.guardedMutation(header.id, 'persistBatch', () => super.persistBatch(header, events, materialized, inheritedEventCount));
    }

    persistHeader(header, inheritedEventCount) {
      return this.guardedMutation(header.id, 'persistHeader', () => super.persistHeader(header, inheritedEventCount));
    }

    truncateTornTail(header, offset) {
      return this.guardedMutation(header.id, 'truncateTornTail', () => super.truncateTornTail(header, offset));
    }
  }
  guardedProviders.set(Provider, GuardedJsonlProvider);
  return GuardedJsonlProvider;
}
