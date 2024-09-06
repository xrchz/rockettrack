#!/usr/bin/env node

import { program } from 'commander'
import { ethers } from 'ethers'
import fs from 'fs/promises'
import util from 'util'
import { exec as cpexec } from 'child_process'
const exec = util.promisify(cpexec)

const rocketStorageAddress = '0x1d8f8f00cfa6758d7bE78336684788Fb0ee0Fa46'

program.option('-r, --rpc <url>', 'Full node RPC endpoint URL', 'http://localhost:8545')
       .option('-s, --from-block <block>', 'block to collect events from (uses last block in file by default)')
       .option('-t, --to-block <block>', 'block to collect events until')
       .option('-m, --max-query-size <num>', 'maximum number of blocks to query for events at once', 100000)
       .option('-f, --file <file>', 'file to append sorted events to', 'balances.jsonl')
program.parse()
const options = program.opts()

const oneEther = ethers.parseUnits('1', 'ether')

const provider = new ethers.JsonRpcProvider(options.rpc)

// BalancesUpdated(block, totalEth, stakingEth, rethSupply, time)
// BalancesUpdated(block, slotTimestamp, totalEth, stakingEth, rethSupply, time)

const rocketStorage = new ethers.Contract(
  rocketStorageAddress, ["function getAddress(bytes32 key) view returns (address)"], provider)
const balancesAddress = await rocketStorage['getAddress(bytes32)'](ethers.id("contract.addressrocketNetworkBalances"))
const balancesABI = JSON.parse(await fs.readFile('balancesABI.json', 'utf-8'))
const balancesContract = new ethers.Contract(balancesAddress, balancesABI, provider)
let fromBlock = options.fromBlock && `0x${BigInt(options.fromBlock).toString(16)}`
if (!fromBlock) {
  const { error, stdout, stderr } = await exec(`tail -n 1 ${options.file}`)
  if (error) {
    console.log(`error reading ${options.file}: ${stderr}`)
    process.exit(1)
  }
  fromBlock = JSON.parse(stdout)[0]
}
const latestBlock = await provider.getBlockNumber()
const toBlock = options.toBlock ? parseInt(options.toBlock) : latestBlock
const maxQuerySize = parseInt(options.maxQuerySize)
const events = []
let min = parseInt(fromBlock)
let max = min
while (max < toBlock) {
  max = Math.min(toBlock, min + maxQuerySize)
  console.log(`retrieving events from ${min} to ${max}`)
  events.push(...await balancesContract.queryFilter('BalancesUpdated', min, max))
  min = max + 1
}
console.log('reducing to args')
const args = events.map(e => e.args)
console.log('sorting args')
args.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
if (!options.fromBlock && args.length && `0x${args[0][0].toString(16)}` === fromBlock) {
  console.log('removing sentinel')
  args.shift()
}
if (!args.length) {
  console.log('no new events')
}
else {
  console.log(`appending to ${options.file}`)
  await fs.writeFile(options.file, args.map(l => JSON.stringify(l.map(n => `0x${n.toString(16)}`))).join('\n').concat('\n'), {flag: 'a'})
}
