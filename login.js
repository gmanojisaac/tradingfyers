require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { fyersModel } = require('fyers-api-v3');

const { FYERS_APP_ID: appId, FYERS_SECRET_ID: secret, FYERS_REDIRECT_URL: redirect } = process.env;
const authCode = process.argv[2];
const fyers = new fyersModel({ path: 'logs', enableLogging: false });
fyers.setAppId(appId);
fyers.setRedirectUrl(redirect);

(async () => {
  if (!authCode) {
    console.log('1) Open this URL, log in, then copy the auth_code from the redirected URL:\n');
    console.log(fyers.generateAuthCode());
    console.log('\n2) Run: npm run login -- <auth_code>');
    return;
  }
  const res = await fyers.generate_access_token({ client_id: appId, secret_key: secret, auth_code: authCode });
  if (res.s !== 'ok') throw new Error(JSON.stringify(res));
  const envPath = path.join(__dirname, '.env');
  let env = fs.readFileSync(envPath, 'utf8');
  env = /^FYERS_ACCESS_TOKEN=.*$/m.test(env)
    ? env.replace(/^FYERS_ACCESS_TOKEN=.*$/m, `FYERS_ACCESS_TOKEN=${res.access_token}`)
    : env + `\nFYERS_ACCESS_TOKEN=${res.access_token}\n`;
  fs.writeFileSync(envPath, env);
  console.log('Access token saved to .env');
})().catch((e) => { console.error(e.message); process.exit(1); });
