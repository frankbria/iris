# #352: credential references for fill values

*2026-10-10T03:19:20Z by Showboat 0.6.1*
<!-- showboat-id: e12415bf-d6c9-4a0e-a61b-539af766b329 -->

Real built CLI (`node dist/cli.js`, this branch) and real Chromium. The AI is a scripted fake Ollama on 127.0.0.1:47352 that also serves a login page (a password field whose input is echoed as `typed: …` in a paragraph) and logs every AI request body it receives, so 'what the model was sent' is read from those logs. The secret value in every step is `Hunter2-demo-9Qx`, exported as `IRIS_SECRET_LOGIN_PW` (and `SECRET_VALUE` for the checks). `$SCRATCH` is a scratch dir holding the fakes and scripts.

## Criterion 1 + 2: the value is typed at fill time; the AI sees only the reference
One-shot `iris run` through the AI path. The model plans a fill with the reference; the CLI JSON and the AI request never contain the value.

```bash
$SCRATCH/run352.sh '[[{"type":"fill","selector":"#pw","text":"{{secret:LOGIN_PW}}"}]]' -- 'sign in using the password {{secret:LOGIN_PW}}'
```

```output
ok   {"type":"navigate","url":"http://127.0.0.1:47352/"} 
ok   {"type":"fill","selector":"#pw","text":"{{secret:LOGIN_PW}}"} 
status: success
secret in CLI JSON: false
AI request 1: Translate this natural language instruction into browser automation actions: "sign in using the password {{secret:LOGIN_PW}}"
AI requests: 1  secret in any AI request: false  reference in AI request: true
```

## Criterion 2: the agent loop's page digest does not carry the value
`--agent`: turn 1 fills the user (literal `alice`, the positive control) and the password by reference; turn 2's AI request carries the page digest. The digest shows field values, so the password field and the echo paragraph read `<redacted>`: that is also the evidence the value really was typed.

```bash
$SCRATCH/run352.sh '[[{"type":"fill","selector":"#user","text":"alice"},{"type":"fill","selector":"#pw","text":"{{secret:LOGIN_PW}}"}],[{"type":"assert","kind":"text_visible","target":"typed:"}]]' -- --agent --max-turns 2 'sign in as alice with the password {{secret:LOGIN_PW}}'
```

```output
ok   {"type":"navigate","url":"http://127.0.0.1:47352/"} 
ok   {"type":"fill","selector":"#user","text":"alice"} 
ok   {"type":"fill","selector":"#pw","text":"{{secret:LOGIN_PW}}"} 
ok   {"type":"assert","kind":"text_visible","target":"typed:"} 
status: success
secret in CLI JSON: false
AI request 1: Translate this natural language instruction into browser automation actions: "sign in as alice with the password {{secret:LOGIN_PW}}"
   digest: - textbox "User"
   digest: - textbox "Password"
AI request 2: Translate this natural language instruction into browser automation actions: "sign in as alice with the password {{secret:LOGIN_PW}}"
   digest: - textbox "User": alice
   digest: - textbox "Password": <redacted>
   digest: - paragraph: "typed: <redacted>"
AI requests: 2  secret in any AI request: false  reference in AI request: true
```

## Criteria 1-3: the executor resolves at fill time, scrubs errors, refuses bad references
The built `ActionExecutor` on a real Chromium page (local mode, so the source is `IRIS_SECRET_<NAME>`). Playwright quotes the typed value in a failed fill's call log, and previews an element's attributes in any action's error: both show `<redacted>`. An unknown reference fails naming the reference; an embedded one is refused.

```bash
NODE_PATH=$PWD/node_modules node $SCRATCH/exec352.js
```

```output
IRIS_HOSTED=(unset)
fill #pw with {{secret:LOGIN_PW}}: ok
  value in result: false
  #pw now holds the value: true
fill read-only #ro with {{secret:LOGIN_PW}} (Playwright quotes the value): FAIL  error: page.fill: Timeout 1000ms exceeded. | - locator resolved to <input id="ro" readonly/> | - fill("<redacted>")
  value in result: false
fill #mirror (reflects into value="…"), then click it under a cover: ok
  value in result: false
  click #mirror: FAIL  error: page.click: Timeout 1000ms exceeded. | - locator resolved to <input id="mirror" value="<redacted>" oninput="this.setAttribute('value', this.value)"/>
  value in result: false
fill #pw with {{secret:NOPE}}: FAIL  error: Unknown credential reference {{secret:NOPE}}
  value in result: false
fill #pw with "pw: {{secret:LOGIN_PW}}": FAIL  error: Invalid credential reference: the whole fill value must be {{secret:NAME}}, NAME of letters, digits and _
  value in result: false
```

## Criterion 4: hosted, the server's environment is never a source
Same script under `IRIS_HOSTED=1`, with `IRIS_SECRET_LOGIN_PW` still exported: the reference is unknown.

```bash
IRIS_HOSTED=1 NODE_PATH=$PWD/node_modules node $SCRATCH/exec352.js
```

```output
IRIS_HOSTED=1
fill #pw with {{secret:LOGIN_PW}}: FAIL  error: Unknown credential reference {{secret:LOGIN_PW}}
  value in result: false
```

## Criterion 4 (RPC): the request's `secrets` are the only source
A real `iris connect` (local token mode) whose own environment exports `IRIS_SECRET_FROM_ENV`. A request's `secrets` resolve and the value reaches the page (step 2 asserts the echo), yet no reply carries it; the server's env value is not used even in local mode; a bad key is `-32602`.

```bash
$SCRATCH/rpc352.sh
```

```output
1. fill {{secret:PW}} with the value in this request's secrets:
  ok   {"type":"navigate","url":"http://127.0.0.1:47352/"}
  ok   {"type":"fill","selector":"#pw","text":"{{secret:PW}}"}
  value in reply: false
2. the page received the value (assert "typed: <value>" visible): true
3. {{secret:FROM_ENV}}: set in the server's environment, not in the request:
  FAIL {"type":"fill","selector":"#pw","text":"{{secret:FROM_ENV}}"}  error: Unknown credential reference {{secret:FROM_ENV}}
  value in reply: false
4. a secrets key that is not a NAME:
  error -32602 Invalid params
```

## Criterion 5: regression tests
`credential-refs.test.ts` (real Chromium) and the RPC case in `protocol.test.ts`.

```bash
npx jest __tests__/credential-refs.test.ts 2>&1 | grep -E '^Tests:'; npx jest __tests__/protocol.test.ts -t 'secret' 2>&1 | grep -E '^Tests:'
```

```output
Tests:       24 passed, 24 total
Tests:       29 skipped, 1 passed, 30 total
```
