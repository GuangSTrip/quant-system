import test from 'node:test';
import assert from 'node:assert/strict';
import {campusIP} from '../scripts/campus-network.mjs';
test('campus boundary includes confirmed 10.248/13 networks and loopback',()=>{
 for(const ip of ['127.0.0.1','10.248.0.0','10.249.44.186','10.250.0.1','10.251.255.255','10.252.1.2','10.253.1.28','10.254.0.1','10.255.255.255','::ffff:10.249.44.186'])assert.equal(campusIP(ip),true,ip);
 for(const ip of ['10.247.255.255','11.0.0.0','10.25.1.1','192.168.1.1','8.8.8.8','10.253.256.1','10.253.1.28.evil','garbage',''])assert.equal(campusIP(ip),false,ip);
});
