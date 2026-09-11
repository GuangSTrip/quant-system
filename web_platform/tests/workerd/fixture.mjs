export default {async fetch(request){
  const url=new URL(request.url);
  if(!['paper-api.alpaca.markets','data.alpaca.markets'].includes(url.host))throw new Error('Credentials followed a redirect');
  if(request.headers.get('APCA-API-KEY-ID')!=='fixture-key'||request.headers.get('APCA-API-SECRET-KEY')!=='fixture-secret')throw new Error('Credentials not forwarded');
  if(url.pathname==='/redirect')return Response.redirect('https://untrusted.invalid/collect',302);
  if(url.pathname==='/missing')return new Response('{}',{status:404});
  if(url.pathname==='/failure')return new Response(JSON.stringify({message:'fixture-secret rejected'}),{status:401});
  if(request.method==='DELETE')return new Response(null,{status:204});
  if(request.method==='POST')return Response.json({id:'broker-fixture-order',...await request.json(),status:'new'});
  return Response.json({status:'ACTIVE',method:request.method,host:url.host});
}};
