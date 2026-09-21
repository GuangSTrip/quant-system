import test from 'node:test';
import assert from 'node:assert/strict';
import {campusIP} from '../scripts/campus-network.mjs';
test('campus boundary includes only confirmed four networks and loopback',()=>{
 for(const ip of ['127.0.0.1','10.250.0.1','10.251.255.255','10.252.1.2','10.253.1.28','::ffff:10.253.1.28'])assert.equal(campusIP(ip),true,ip);
 for(const ip of ['10.249.255.255','10.254.0.1','10.25.1.1','192.168.1.1','8.8.8.8','10.253.256.1','10.253.1.28.evil','garbage',''])assert.equal(campusIP(ip),false,ip);
});
