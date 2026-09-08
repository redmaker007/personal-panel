// Only acknowledged events are removed. An uncertain response leaves the exact
// original sequence in the outbox, making a subsequent retry safe.
// A thrown error carries `sessionId` so the caller can tell which session failed
// (e.g. one the server no longer recognises after a database reset).
export async function drainOutbox(vault, request, persist, isCancelled = () => false) {
  for (const session of vault.sessions) {
    if (isCancelled()) return;
    try {
      if (!session.created) {
        const ack = await request('/sessions', { id: session.id, token: session.token, clientId: vault.clientId, catalogVersion: session.catalogVersion, version: session.version });
        if (isCancelled()) return;
        if (!Number.isInteger(ack.seq) || ack.seq < 0 || ack.seq > session.seq) throw new Error('另一处进度较新，请刷新此页再继续');
        session.created = true;
        session.ack = ack.seq;
        session.events = session.events.filter(e => e.seq > session.ack);
        persist();
      }
      while (session.events.length && !isCancelled()) {
        const events = session.events.slice(0, 60);
        const ack = await request('/sessions/' + session.id + '/events', { events }, session.token);
        if (isCancelled()) return;
        if (!Number.isInteger(ack.seq) || ack.seq < events.at(-1).seq || ack.seq > session.seq) throw new Error('同步回执不完整，待同步记录已保留');
        session.ack = ack.seq;
        session.events = session.events.filter(e => e.seq > session.ack);
        persist();
      }
    } catch (e) {
      if (e && e.sessionId === undefined) e.sessionId = session.id;
      throw e;
    }
  }
}
