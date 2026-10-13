/**
 * A stand-in for the `sql` tag that answers a page's ledger reads from fixed
 * rows, for tests that render a page or call a route. `synced_workouts` reads
 * get `terminal`, `pending_uploads` reads get `pending`, a count gets the
 * number of terminal rows, and anything else gets no rows. Every query text
 * is kept, so a test can check what was selected.
 */
export function ledgerSql(terminal: Array<Record<string, unknown>>, pending: Array<Record<string, unknown>> = []) {
  const queries: string[] = [];
  const sql = (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    queries.push(text);
    let rows: unknown[] = [];
    if (/count\(\*\)/i.test(text)) rows = [{ total: terminal.length }];
    else if (text.includes("FROM synced_workouts")) rows = terminal;
    else if (text.includes("FROM pending_uploads")) rows = pending;
    return Promise.resolve(rows);
  };
  return { sql, queries };
}
