// Fork punkpeye/awesome-mcp-servers, add our entry to Finance & Fintech,
// open PR. Uses process.env.GITHUB_TOKEN. Touches ONLY the fork's README.md.
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("GITHUB_TOKEN env var required");
  process.exit(1);
}

const UPSTREAM = { owner: "punkpeye", repo: "awesome-mcp-servers" };
const USER = "ValleyofJays";
const ENTRY =
  "- [g-calf/polymarket-odds-x402](https://github.com/g-calf/polymarket-odds-x402) 📇 ☁️ - Pay-per-call x402 API on Base mainnet for live Polymarket and Kalshi prediction market odds. MCP server [`@gcalf/mcp`](https://www.npmjs.com/package/@gcalf/mcp) exposes `get_polymarket_odds`, `get_kalshi_odds` and batch tools. $0.001–$0.02 USDC per call, no API keys, pre-paywall validation so bad slugs never charge.";

async function gh(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "g-calf-submit",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  if (!res.ok) {
    throw new Error(
      `${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 500)}`,
    );
  }
  return json;
}

// 1. Fork (idempotent — if fork exists, GitHub returns 202 with the existing repo)
console.log("1. forking punkpeye/awesome-mcp-servers...");
await gh("POST", `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/forks`);

// 2. Wait for fork to materialize
console.log("2. waiting for fork...");
let ready = false;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  try {
    await gh("GET", `/repos/${USER}/${UPSTREAM.repo}`);
    ready = true;
    break;
  } catch {}
}
if (!ready) throw new Error("fork did not appear within 60s");
console.log("   fork ready");

// 3. Make sure fork's main is up-to-date with upstream
console.log("3. syncing fork's main with upstream...");
try {
  await gh("POST", `/repos/${USER}/${UPSTREAM.repo}/merge-upstream`, {
    branch: "main",
  });
} catch (e) {
  console.log("   sync note:", String(e).slice(0, 200));
}

// 4. Get current README. The /contents endpoint returns empty content
// for files >1 MB (this README is 1.6 MB), so we fetch raw via the Git
// blob API using the sha from a tree lookup.
console.log("4. fetching README.md via Git data API (large-file path)...");
const branch = await gh(
  "GET",
  `/repos/${USER}/${UPSTREAM.repo}/branches/main`,
);
const latestCommit = branch.commit.sha;
const tree = await gh(
  "GET",
  `/repos/${USER}/${UPSTREAM.repo}/git/trees/${latestCommit}`,
);
const readmeEntry = tree.tree.find((t) => t.path === "README.md");
if (!readmeEntry) throw new Error("README.md not found in tree");
const blob = await gh(
  "GET",
  `/repos/${USER}/${UPSTREAM.repo}/git/blobs/${readmeEntry.sha}`,
);
const original = Buffer.from(blob.content, "base64").toString("utf8");
const file = { sha: readmeEntry.sha };

// 5. Locate Finance & Fintech section and insert alphabetically
console.log("5. finding Finance & Fintech section...");
// Section headings use anchors like: ### 💰 <a name="finance--fintech"></a>Finance & Fintech
console.log(`   README length: ${original.length} bytes`);
console.log(`   first "finance" hit: ${original.toLowerCase().indexOf("finance")}`);
console.log(`   first "fintech" hit: ${original.toLowerCase().indexOf("fintech")}`);
const financeIdx = original.toLowerCase().indexOf("fintech");
if (financeIdx > 0) {
  console.log(`   context at fintech: "${original.slice(Math.max(0, financeIdx - 80), financeIdx + 80)}"`);
}
const anchorIdx = original.indexOf('name="finance--fintech"');
if (anchorIdx === -1) {
  throw new Error("could not find finance--fintech anchor in README");
}
// Jump to end of heading line
const eolAfterHeading = original.indexOf("\n", anchorIdx);
const sectionStart = eolAfterHeading + 1;
// Section ends at the next top-level or sub-level heading
const sectionEndRe = /\n(##+ )/g;
sectionEndRe.lastIndex = sectionStart;
const nextHeading = sectionEndRe.exec(original);
const sectionEnd = nextHeading ? nextHeading.index + 1 : original.length;
const section = original.slice(sectionStart, sectionEnd);
console.log(`   section is ${sectionEnd - sectionStart} bytes, ${section.split("\n").length} lines`);

// Insert alphabetically among bullet lines starting with "- ["
const lines = section.split("\n");
const bullets = [];
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith("- [")) bullets.push({ i, text: lines[i] });
}
if (bullets.length === 0) throw new Error("no bullet entries in Finance & Fintech");

// Find alphabetical insertion by owner/repo substring of each bullet
function sortKey(line) {
  const m = line.match(/- \[([^\]]+)\]/);
  return (m ? m[1] : line).toLowerCase();
}
const myKey = sortKey(ENTRY);
let insertBeforeLine = bullets[bullets.length - 1].i + 1; // default append
for (const b of bullets) {
  if (sortKey(b.text) > myKey) {
    insertBeforeLine = b.i;
    break;
  }
}

// Check for an existing entry (idempotency)
if (section.includes("g-calf/polymarket-odds-x402")) {
  console.log("   entry already present — nothing to insert");
} else {
  lines.splice(insertBeforeLine, 0, ENTRY);
  console.log(
    `   inserting at line ${insertBeforeLine} of section (between entries ${
      bullets.find((b) => sortKey(b.text) > myKey)?.text?.slice(0, 60) ?? "end"
    })`,
  );
}
const newSection = lines.join("\n");
const newContent = original.slice(0, sectionStart) + newSection + original.slice(sectionEnd);

if (newContent === original) {
  console.log("no changes; aborting commit + PR");
  process.exit(0);
}

// 6. Commit via Git data API (needed because file > 1 MB).
console.log("6. committing to fork's main (git data API)...");
const newBlob = await gh("POST", `/repos/${USER}/${UPSTREAM.repo}/git/blobs`, {
  content: Buffer.from(newContent, "utf8").toString("base64"),
  encoding: "base64",
});
const newTree = await gh("POST", `/repos/${USER}/${UPSTREAM.repo}/git/trees`, {
  base_tree: latestCommit,
  tree: [
    { path: "README.md", mode: "100644", type: "blob", sha: newBlob.sha },
  ],
});
const newCommit = await gh(
  "POST",
  `/repos/${USER}/${UPSTREAM.repo}/git/commits`,
  {
    message:
      "Add g-calf/polymarket-odds-x402 to Finance & Fintech (prediction market odds via x402)",
    tree: newTree.sha,
    parents: [latestCommit],
    author: { name: "g-calf", email: "parab01ek@gmail.com" },
    committer: { name: "g-calf", email: "parab01ek@gmail.com" },
  },
);
await gh("PATCH", `/repos/${USER}/${UPSTREAM.repo}/git/refs/heads/main`, {
  sha: newCommit.sha,
});

// 7. Open PR against upstream
console.log("7. opening PR...");
const pr = await gh("POST", `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls`, {
  title: "Add g-calf/polymarket-odds-x402 (prediction market odds, x402)",
  head: `${USER}:main`,
  base: "main",
  body: `Adds [\`@gcalf/mcp\`](https://www.npmjs.com/package/@gcalf/mcp) + its backing API to the Finance & Fintech section.

- npm: https://www.npmjs.com/package/@gcalf/mcp
- API: https://polymarket-odds-x402.goldencalf.workers.dev
- Source: https://github.com/g-calf/polymarket-odds-x402

Niche: single-source Polymarket + Kalshi specialization (rather than a general-purpose x402 gateway). All endpoints have JSON Schema discovery at \`/.well-known/x402\` and \`/openapi.json\`; a pre-paywall validator means bad slugs return 404 without taking payment.`,
  maintainer_can_modify: true,
});

console.log(`\nPR opened: ${pr.html_url}`);
