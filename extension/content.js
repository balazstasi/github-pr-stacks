(() => {
  'use strict';

  const LIST_SELECTOR = 'ul[data-listview-component="items-list"]';
  const TITLE_LINK_SELECTOR = 'a[data-testid="listitem-title-link"]';
  const TITLE_CONTAINER_SELECTOR = '[data-listview-item-title-container]';
  const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;
  const PULLS_PATH = /(^|\/)pulls(\/|$)/;
  const CACHE_TTL_MS = 60_000;
  const MAX_STACK_PAGES = 5;
  const FETCH_CONCURRENCY = 6;
  const PALETTE = ['#a371f7', '#388bfd', '#f0883e', '#db61a2', '#3fb9a6', '#d4a72c'];
  const STACK_ICON =
    '<svg class="ghs-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M7.122.392a1.75 1.75 0 0 1 1.756 0l5.003 2.902c.83.481.83 1.68 0 2.162L8.878 8.358a1.75 1.75 0 0 1-1.756 0L2.119 5.456a1.251 1.251 0 0 1 0-2.162ZM8.125 1.69a.248.248 0 0 0-.25 0l-4.63 2.685 4.63 2.685a.248.248 0 0 0 .25 0l4.63-2.685ZM1.601 7.789a.75.75 0 0 1 1.025-.273l5.249 3.044a.248.248 0 0 0 .25 0l5.249-3.044a.75.75 0 0 1 .752 1.298l-5.248 3.044a1.75 1.75 0 0 1-1.756 0L1.874 8.814A.75.75 0 0 1 1.6 7.789Zm0 3.5a.75.75 0 0 1 1.025-.273l5.249 3.044a.248.248 0 0 0 .25 0l5.249-3.044a.75.75 0 0 1 .752 1.298l-5.248 3.044a1.75 1.75 0 0 1-1.756 0l-5.248-3.044a.75.75 0 0 1-.273-1.025Z"></path></svg>';

  const settings = { group: true };
  const cache = { open: new Map(), completed: new Map() };
  let scheduled = 0;
  let observer = null;

  async function getPayload(path) {
    const res = await fetch(path, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    return (await res.json()).payload;
  }

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    });
    await Promise.all(workers);
    return out;
  }

  async function loadIndex(repo, completed) {
    const summaries = [];
    for (let page = 1; page <= MAX_STACK_PAGES; page++) {
      const params = new URLSearchParams();
      if (completed) params.set('state', 'completed');
      if (page > 1) params.set('page', String(page));
      const query = params.toString();
      const payload = await getPayload(`/${repo}/stacks${query ? `?${query}` : ''}`);
      const route = payload.repoStacksListRoute;
      summaries.push(...route.stacks);
      if (page >= route.totalPages) break;
    }

    const ranked = summaries.map((s) => Number(s.number)).sort((a, b) => a - b);
    const details = await mapLimit(summaries, FETCH_CONCURRENCY, async (summary) => {
      try {
        const payload = await getPayload(`/${repo}/stack/${summary.number}`);
        return payload.repoStackDetailRoute;
      } catch (err) {
        console.debug('[PR Stacks] stack detail failed', summary.number, err);
        return null;
      }
    });

    const byPr = new Map();
    details.forEach((detail) => {
      if (!detail) return;
      const { stack, pullRequests } = detail;
      const number = Number(stack.number);
      const info = {
        key: `${repo}#${number}`,
        repo,
        number,
        url: stack.url,
        base: stack.baseRefName,
        size: stack.size,
        merged: stack.mergedCount || 0,
        color: PALETTE[ranked.indexOf(number) % PALETTE.length],
        members: pullRequests
          .map((pr) => ({
            number: pr.number,
            position: pr.stackPosition,
            title: pr.title,
            url: pr.permalink,
            state: pr.displayState.replace('REPO_PULL_REQUEST_DISPLAY_STATE_', '').toLowerCase(),
          }))
          .sort((a, b) => a.position - b.position),
      };
      info.members.forEach((member) => byPr.set(member.number, { stack: info, member }));
    });
    return byPr;
  }

  function ensureIndex(kind, repo) {
    let entry = cache[kind].get(repo);
    if (!entry) {
      entry = { at: 0, loading: false, byPr: new Map() };
      cache[kind].set(repo, entry);
    }
    if (entry.loading || Date.now() - entry.at < CACHE_TTL_MS) return;
    entry.loading = true;
    loadIndex(repo, kind === 'completed')
      .then((byPr) => {
        entry.byPr = byPr;
      })
      .catch((err) => console.debug('[PR Stacks] index failed', repo, err))
      .finally(() => {
        entry.at = Date.now();
        entry.loading = false;
        schedule();
      });
  }

  function lookup(repo, number) {
    return cache.open.get(repo)?.byPr.get(number) || cache.completed.get(repo)?.byPr.get(number) || null;
  }

  function readRows(ul) {
    const rows = [];
    for (const li of ul.children) {
      if (li.dataset.ghsOwn) continue;
      const link = li.querySelector(TITLE_LINK_SELECTOR);
      if (!link) continue;
      const match = PR_PATH.exec(new URL(link.href, location.origin).pathname);
      if (!match) continue;
      const stateLabel = li.querySelector('svg.octicon[aria-label]')?.getAttribute('aria-label') || '';
      rows.push({
        li,
        repo: `${match[1]}/${match[2]}`,
        number: Number(match[3]),
        finished: /merged|closed/i.test(stateLabel),
        hit: null,
      });
    }
    return rows;
  }

  function setAttr(node, name, value) {
    if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  }

  function setVar(node, name, value) {
    if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
  }

  function setOrder(node, value) {
    const next = value === null ? '' : String(value);
    if (node.style.order !== next) node.style.order = next;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function undecorateRow(li) {
    if (!li.classList.contains('ghs-row')) return;
    li.classList.remove('ghs-row', 'ghs-first', 'ghs-last');
    li.removeAttribute('data-ghs-stack');
    li.style.removeProperty('--ghs-color');
    setOrder(li, null);
    li.querySelector('.ghs-badge')?.remove();
    li.querySelector(TITLE_CONTAINER_SELECTOR)?.classList.remove('ghs-title');
  }

  function decorateRow(row, first, last) {
    const { li, hit } = row;
    const { stack, member } = hit;
    li.classList.add('ghs-row');
    li.classList.toggle('ghs-first', first);
    li.classList.toggle('ghs-last', last);
    setAttr(li, 'data-ghs-stack', stack.key);
    setVar(li, '--ghs-color', stack.color);

    const container = li.querySelector(TITLE_CONTAINER_SELECTOR);
    if (!container) return;
    container.classList.add('ghs-title');

    let badge = container.querySelector(':scope > .ghs-badge');
    if (!badge) {
      badge = el('a', 'ghs-badge');
      badge.insertAdjacentHTML('afterbegin', STACK_ICON);
      badge.append(el('span', 'ghs-badge-pos'));
      const heading = container.querySelector(':scope > h3');
      if (heading) heading.after(badge);
      else container.append(badge);
    }
    setAttr(badge, 'href', stack.url);
    setAttr(
      badge,
      'title',
      `Stack #${stack.number}: PR ${member.position} of ${stack.size}, targeting ${stack.base}. Click to open the stack.`,
    );
    setAttr(badge, 'aria-label', `Open stack #${stack.number}, pull request ${member.position} of ${stack.size}`);
    const pos = badge.querySelector('.ghs-badge-pos');
    const text = `${member.position}/${stack.size}`;
    if (pos.textContent !== text) pos.textContent = text;
  }

  function buildHeader(group) {
    const { stack } = group;
    const li = el('li', 'ghs-header');
    li.dataset.ghsOwn = '1';
    li.dataset.ghsHeader = stack.key;
    li.style.setProperty('--ghs-color', stack.color);

    const title = el('a', 'ghs-header-title');
    title.insertAdjacentHTML('afterbegin', STACK_ICON);
    title.append(el('span', null, `Stack #${stack.number}`));
    title.href = stack.url;
    title.title = `Open stack #${stack.number}`;
    li.append(title);

    const mergedText = stack.merged ? ` · ${stack.merged}/${stack.size} merged` : '';
    li.append(el('span', 'ghs-header-meta', `${stack.size} PRs → ${stack.base}${mergedText}`));

    const chain = el('span', 'ghs-chain');
    const inList = new Set(group.rows.map((r) => r.number));
    stack.members.forEach((member, i) => {
      if (i > 0) chain.append(el('span', 'ghs-arrow', '→'));
      const pill = el('a', `ghs-pill ghs-state-${member.state}${inList.has(member.number) ? '' : ' ghs-elsewhere'}`);
      pill.href = member.url;
      pill.title = `#${member.number} · ${member.state} · ${member.title}`;
      pill.append(el('span', 'ghs-dot'), el('span', null, `#${member.number}`));
      chain.append(pill);
    });
    li.append(chain);

    const open = el('a', 'ghs-open', 'Open stack');
    open.href = stack.url;
    li.append(open);
    return li;
  }

  function headerSignature(group) {
    return `${group.stack.members.map((m) => `${m.number}:${m.state}`).join(',')}|${group.rows
      .map((r) => r.number)
      .join(',')}`;
  }

  function buildToolbar() {
    const li = el('li', 'ghs-toolbar');
    li.dataset.ghsOwn = '1';
    const summary = el('span', 'ghs-toolbar-summary');
    summary.insertAdjacentHTML('afterbegin', STACK_ICON);
    summary.append(el('span', 'ghs-toolbar-text'));
    const label = el('label', 'ghs-toggle');
    const input = el('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => {
      settings.group = input.checked;
      try {
        chrome.storage.local.set({ group: settings.group });
      } catch (err) {
        console.debug('[PR Stacks] could not persist setting', err);
      }
      schedule();
    });
    label.append(input, el('span', null, 'Group stacks'));
    li.append(summary, label);
    return li;
  }

  function decorateList(ul) {
    const rows = readRows(ul);
    if (!rows.length) return;

    new Set(rows.map((r) => r.repo)).forEach((repo) => ensureIndex('open', repo));
    rows.forEach((row) => {
      row.hit = lookup(row.repo, row.number);
    });
    new Set(rows.filter((r) => !r.hit && r.finished).map((r) => r.repo)).forEach((repo) =>
      ensureIndex('completed', repo),
    );
    rows.forEach((row) => {
      if (!row.hit) row.hit = lookup(row.repo, row.number);
    });

    const groups = new Map();
    rows.forEach((row, index) => {
      if (!row.hit) return;
      const key = row.hit.stack.key;
      if (!groups.has(key)) groups.set(key, { stack: row.hit.stack, rows: [], anchor: index });
      groups.get(key).rows.push(row);
    });
    groups.forEach((group) => group.rows.sort((a, b) => a.hit.member.position - b.hit.member.position));

    rows.forEach((row) => {
      if (!row.hit) undecorateRow(row.li);
    });
    groups.forEach((group) => {
      group.rows.forEach((row, i) => decorateRow(row, i === 0, i === group.rows.length - 1));
    });

    let toolbar = ul.querySelector(':scope > li.ghs-toolbar');
    const headers = new Map();
    ul.querySelectorAll(':scope > li.ghs-header').forEach((header) => {
      const group = groups.get(header.dataset.ghsHeader);
      if (!settings.group || !group || header.dataset.ghsSig !== headerSignature(group)) {
        header.remove();
      } else {
        headers.set(header.dataset.ghsHeader, header);
      }
    });

    if (!groups.size) {
      toolbar?.remove();
      ul.classList.remove('ghs-grouped');
      return;
    }

    if (settings.group) {
      groups.forEach((group, key) => {
        if (headers.has(key)) return;
        const header = buildHeader(group);
        header.dataset.ghsSig = headerSignature(group);
        const firstInDom = group.rows
          .map((r) => r.li)
          .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))[0];
        ul.insertBefore(header, firstInDom);
        headers.set(key, header);
      });
    }

    if (!toolbar) toolbar = buildToolbar();
    if (ul.firstChild !== toolbar) ul.insertBefore(toolbar, ul.firstChild);
    const stackedCount = [...groups.values()].reduce((n, g) => n + g.rows.length, 0);
    const text = `${groups.size} ${groups.size === 1 ? 'stack' : 'stacks'} · ${stackedCount} of ${rows.length} PRs`;
    const textNode = toolbar.querySelector('.ghs-toolbar-text');
    if (textNode.textContent !== text) textNode.textContent = text;
    const checkbox = toolbar.querySelector('input');
    if (checkbox.checked !== settings.group) checkbox.checked = settings.group;

    ul.classList.toggle('ghs-grouped', settings.group);
    setOrder(toolbar, settings.group ? -1 : null);
    headers.forEach((header, key) => setOrder(header, groups.get(key).anchor * 1000));
    rows.forEach((row, index) => {
      if (!settings.group) return setOrder(row.li, null);
      const anchor = row.hit ? groups.get(row.hit.stack.key).anchor : index;
      setOrder(row.li, anchor * 1000 + (row.hit ? row.hit.member.position : 0) + 1);
    });
  }

  function run() {
    scheduled = 0;
    if (!PULLS_PATH.test(location.pathname)) return;
    const lists = document.querySelectorAll(LIST_SELECTOR);
    if (!lists.length) return;
    observer.disconnect();
    try {
      lists.forEach(decorateList);
    } catch (err) {
      console.error('[PR Stacks]', err);
    } finally {
      observer.takeRecords();
      observe();
    }
  }

  function schedule() {
    if (!scheduled) scheduled = window.setTimeout(run, 80);
  }

  function observe() {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  try {
    chrome.storage.local.get({ group: true }, (stored) => {
      settings.group = stored.group !== false;
      schedule();
    });
  } catch (err) {
    console.debug('[PR Stacks] storage unavailable', err);
  }
  observer = new MutationObserver(schedule);
  observe();
  schedule();
})();
