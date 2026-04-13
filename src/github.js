/**
 * GitHub API integration — read files, search code, check PRs/actions.
 * Uses GitHub REST API with personal access token.
 */

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DEFAULT_REPO = process.env.GITHUB_REPO || '';
const API_BASE = 'https://api.github.com';

function headers() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'ReminderBot/1.0',
  };
}

/**
 * Read a file from the repo.
 */
export async function readFile(filePath, repo = DEFAULT_REPO, branch = 'main') {
  try {
    const res = await fetch(`${API_BASE}/repos/${repo}/contents/${filePath}?ref=${branch}`, {
      headers: headers(), signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.encoding === 'base64') {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
    return data.content;
  } catch (err) {
    console.error('[GitHub] readFile error:', err.message);
    return null;
  }
}

/**
 * Search code in the repo.
 */
export async function searchCode(query, repo = DEFAULT_REPO) {
  try {
    const res = await fetch(`${API_BASE}/search/code?q=${encodeURIComponent(query)}+repo:${repo}`, {
      headers: headers(), signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items || []).slice(0, 10).map(item => ({
      path: item.path,
      name: item.name,
      url: item.html_url,
    }));
  } catch (err) {
    console.error('[GitHub] searchCode error:', err.message);
    return [];
  }
}

/**
 * List open pull requests.
 */
export async function listPullRequests(repo = DEFAULT_REPO) {
  try {
    const res = await fetch(`${API_BASE}/repos/${repo}/pulls?state=open&per_page=10`, {
      headers: headers(), signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.map(pr => ({
      number: pr.number,
      title: pr.title,
      author: pr.user?.login,
      created: pr.created_at,
      url: pr.html_url,
      draft: pr.draft,
    }));
  } catch (err) {
    console.error('[GitHub] listPRs error:', err.message);
    return [];
  }
}

/**
 * Get recent commits.
 */
export async function getRecentCommits(repo = DEFAULT_REPO, count = 5) {
  try {
    const res = await fetch(`${API_BASE}/repos/${repo}/commits?per_page=${count}`, {
      headers: headers(), signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.map(c => ({
      sha: c.sha.substring(0, 7),
      message: c.commit.message.split('\n')[0],
      author: c.commit.author?.name,
      date: c.commit.author?.date,
    }));
  } catch (err) {
    console.error('[GitHub] getCommits error:', err.message);
    return [];
  }
}

/**
 * Get latest workflow runs (CI/CD status).
 */
export async function getWorkflowRuns(repo = DEFAULT_REPO, count = 5) {
  try {
    const res = await fetch(`${API_BASE}/repos/${repo}/actions/runs?per_page=${count}`, {
      headers: headers(), signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.workflow_runs || []).map(r => ({
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      branch: r.head_branch,
      url: r.html_url,
      created: r.created_at,
    }));
  } catch (err) {
    console.error('[GitHub] getWorkflows error:', err.message);
    return [];
  }
}

/**
 * List directory contents.
 */
export async function listDirectory(dirPath = '', repo = DEFAULT_REPO) {
  try {
    const res = await fetch(`${API_BASE}/repos/${repo}/contents/${dirPath}`, {
      headers: headers(), signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.map(item => ({
      name: item.name,
      type: item.type, // 'file' or 'dir'
      path: item.path,
      size: item.size,
    }));
  } catch (err) {
    console.error('[GitHub] listDir error:', err.message);
    return [];
  }
}

/**
 * Get repo info.
 */
export async function getRepoInfo(repo = DEFAULT_REPO) {
  try {
    const res = await fetch(`${API_BASE}/repos/${repo}`, {
      headers: headers(), signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error('[GitHub] getRepoInfo error:', err.message);
    return null;
  }
}

/**
 * Check if GitHub integration is configured.
 */
export function isConfigured() {
  return !!(GITHUB_TOKEN && DEFAULT_REPO);
}

/**
 * Handle a GitHub-related query from the user.
 * Uses Claude to understand what they're asking and fetches the right data.
 */
export async function handleGithubQuery(query) {
  if (!isConfigured()) return 'GitHub not configured. Set GITHUB_TOKEN and GITHUB_REPO env vars.';

  const lowerQuery = query.toLowerCase();

  // PRs
  if (/\b(pr|pull request|merge|review)\b/i.test(lowerQuery)) {
    const prs = await listPullRequests();
    if (prs.length === 0) return 'No open pull requests.';
    let msg = `*Open PRs (${prs.length}):*\n`;
    for (const pr of prs) {
      const age = Math.floor((Date.now() - new Date(pr.created).getTime()) / 86400000);
      msg += `\n#${pr.number} ${pr.title}${pr.draft ? ' (draft)' : ''}\n  by ${pr.author} — ${age}d ago`;
    }
    return msg;
  }

  // Recent commits
  if (/\b(commit|recent|latest|what changed|git log|history)\b/i.test(lowerQuery)) {
    const commits = await getRecentCommits();
    if (commits.length === 0) return 'No recent commits found.';
    let msg = '*Recent Commits:*\n';
    for (const c of commits) {
      const date = new Date(c.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      msg += `\n\`${c.sha}\` ${c.message}\n  ${c.author} — ${date}`;
    }
    return msg;
  }

  // CI/CD status
  if (/\b(build|deploy|ci|cd|action|workflow|pipeline|status)\b/i.test(lowerQuery)) {
    const runs = await getWorkflowRuns();
    if (runs.length === 0) return 'No workflow runs found.';
    let msg = '*Recent Builds:*\n';
    for (const r of runs) {
      const icon = r.conclusion === 'success' ? '✅' : r.conclusion === 'failure' ? '❌' : '⏳';
      const date = new Date(r.created).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      msg += `\n${icon} ${r.name} (${r.branch}) — ${r.conclusion || r.status}\n  ${date}`;
    }
    return msg;
  }

  // Read a specific file
  if (/\b(read|show|open|file|content of|what does)\b/i.test(lowerQuery)) {
    // Try to extract file path from query
    const pathMatch = lowerQuery.match(/(?:read|show|open|file)\s+(.+?)(?:\s|$)/i) ||
                      lowerQuery.match(/([a-zA-Z0-9_\-/.]+\.[a-zA-Z]+)/);
    if (pathMatch) {
      const filePath = pathMatch[1].trim();
      const content = await readFile(filePath);
      if (!content) return `File "${filePath}" not found in ${DEFAULT_REPO}.`;
      // Truncate long files
      const truncated = content.length > 2000 ? content.substring(0, 2000) + '\n...(truncated)' : content;
      return `*${filePath}:*\n\`\`\`\n${truncated}\n\`\`\``;
    }
  }

  // Search code
  if (/\b(search|find|where|grep|look for)\b/i.test(lowerQuery)) {
    const searchTerm = lowerQuery.replace(/\b(search|find|where|grep|look for|code|in the|in|for)\b/gi, '').trim();
    if (searchTerm.length < 2) return 'What should I search for?';
    const results = await searchCode(searchTerm);
    if (results.length === 0) return `No code found matching "${searchTerm}".`;
    let msg = `*Found ${results.length} result${results.length > 1 ? 's' : ''} for "${searchTerm}":*\n`;
    for (const r of results) { msg += `\n${r.path}`; }
    return msg;
  }

  // List directory
  if (/\b(list|ls|directory|folder|structure|tree)\b/i.test(lowerQuery)) {
    const dirMatch = lowerQuery.match(/(?:list|ls|directory|folder)\s+(.+?)(?:\s|$)/i);
    const dirPath = dirMatch ? dirMatch[1].trim() : '';
    const items = await listDirectory(dirPath);
    if (items.length === 0) return `Directory "${dirPath || '/'}" not found or empty.`;
    let msg = `*${dirPath || 'Root'}:*\n`;
    for (const item of items) {
      msg += `\n${item.type === 'dir' ? '📁' : '📄'} ${item.name}`;
    }
    return msg;
  }

  // Default: show repo overview
  const info = await getRepoInfo();
  if (!info) return 'Could not fetch repo info.';
  const commits = await getRecentCommits(DEFAULT_REPO, 3);
  let msg = `*${info.full_name}*\n${info.description || ''}\n\nBranch: ${info.default_branch}\nLast push: ${new Date(info.pushed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  if (commits.length > 0) {
    msg += '\n\n*Latest:*';
    for (const c of commits) { msg += `\n\`${c.sha}\` ${c.message}`; }
  }
  return msg;
}
