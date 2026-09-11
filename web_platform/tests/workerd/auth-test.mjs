import {makePasswordRecord,verifyPassword,identity} from './auth.mjs';

const check=(condition,message)=>{if(!condition)throw Error(message);};
export default {async test(){
  const fixture={version:1,iterations:100000,salt:'bTVAWrQmnE4kq5ANnxB6ZVqnqbVv9qYHSItIxnUBT-U',hash:'Sh3y0ydmvh_wqBu9E0i1thcyJ3k2uBNTOQ_QOfW8L2A'};
  check(await verifyPassword('fixture-only-password-123',fixture),'Node-generated record must verify in Workerd');
  check(!await verifyPassword('incorrect',fixture),'Incorrect passwords must fail');
  const record=JSON.parse(await makePasswordRecord('runtime-test-password'));
  check(await verifyPassword('runtime-test-password',record),'Workerd must support password record generation');
  const user=await identity(new Request('https://quant.test',{headers:{'oai-authenticated-user-id':'owner','oai-authenticated-user-email':'owner@example.test'}}),{},null);
  check(!user.operator,'OpenAI headers must not provide app authorization');
  console.log('PASS: Workerd PBKDF2 interoperability, wrong password rejection, random password record creation, and independent identity. No external network.');
}};
