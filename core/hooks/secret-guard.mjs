// PreToolUse(Bash): block shell reads of secret files (.env, keys). Silent when fine.
let raw = '';
process.stdin.on('data', (d) => (raw += d)).on('end', () => {
  try {
    const cmd = JSON.parse(raw).tool_input?.command || '';
    const reader = /\b(cat|type|more|less|head|tail|bat|gc|Get-Content|Select-String|grep|rg|findstr|xxd|base64)\b/i;
    const secret = /(^|[\s/\\'"])\.env(\.(?!example\b|sample\b|template\b)[\w.-]+)?(?=$|[\s'"|;&)])|\.(pem|key|pfx|p12)\b|id_(rsa|ed25519)\b/;
    if (reader.test(cmd) && secret.test(cmd)) {
      console.error('Blocked: reading secret files is not allowed. Use .env.example for variable names, or ask the user.');
      process.exit(2);
    }
  } catch { /* never block on hook errors */ }
});
