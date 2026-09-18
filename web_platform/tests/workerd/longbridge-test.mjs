import {seal,unseal,signedHeaders} from './longbridge.mjs';
export default {async test(){
  const env={BROKER_CREDENTIAL_KEY:btoa(String.fromCharCode(...new Uint8Array(32).fill(19)))};
  const credentials={app_key:'fixture-key',app_secret:'fixture-secret',access_token:'fixture-token'};
  const box=await seal(env,credentials),restored=await unseal(env,box);
  if(restored.access_token!==credentials.access_token||box.includes(credentials.app_secret))throw Error('Encryption failed');
  const headers=await signedHeaders(credentials,'/v1/asset/account','currency=HKD','1700000000');
  if(!headers['X-Api-Signature'].includes('Signature='))throw Error('Signature failed');
  console.log('PASS: Longbridge SHA-1/HMAC and AES-GCM in Workerd; no external requests.');
}};
