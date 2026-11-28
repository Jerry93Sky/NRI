import { execFileSync } from 'node:child_process';

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
const paths = git(['ls-files', '-z']).split('\0').filter(Boolean);
const forbiddenFiles = paths.filter((path) =>
  /(^|\/)(\.data|\.backups|uploads)\//.test(path)
  || /(^|\/)\.env(?:\.|$)/.test(path) && !path.endsWith('.example')
  || /\.(?:key|p12|pfx|dump)$/i.test(path)
);

const knownToken = /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{45,}|(?:AKIA|ASIA)[0-9A-Z]{16})/;
const privateKey = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
const credentials = [];
for (const path of paths) {
  if (!/\.(?:ts|tsx|js|mjs|json|y[am]l|md|sql|ps1|sh|conf|env|example|txt)$/i.test(path)) continue;
  const text = git(['show', `:${path}`]);
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (knownToken.test(line) || privateKey.test(line)) credentials.push(`${path}:${index + 1}`);
  }
}
for (const path of forbiddenFiles) console.error(`Local data or key file is tracked: ${path}`);
for (const location of credentials) console.error(`Possible credential at ${location}`);
if (forbiddenFiles.length || credentials.length) process.exitCode = 1;
else console.info(`Checked ${paths.length} tracked files for local data and recognizable credentials.`);
