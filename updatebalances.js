#!/usr/bin/env node

const { program } = require('commander')
const ethers = require('ethers')
const fs = require('fs/promises')

const rocketStorageAddress = '0x1d8f8f00cfa6758d7bE78336684788Fb0ee0Fa46'

program.option('-r, --rpc <url>', 'Full node RPC endpoint URL', 'http://localhost:8545')
       .option('-s, --from-block <block>', 'block to collect events from')
       .option('-t, --to-block <block>', 'block to collect events until')
       .option('-f, --file <file>', 'file to append sorted events to', 'balances.jsonl')
program.parse()
const options = program.opts()

const oneEther = ethers.utils.parseUnits('1', 'ether')

const provider = new ethers.providers.JsonRpcProvider(options.rpc)

// BalancesUpdated(block, totalEth, stakingEth, rethSupply, time)

;(async () => {
  const rocketStorage = new ethers.Contract(
    rocketStorageAddress, ["function getAddress(bytes32 key) view returns (address)"], provider)
  const balancesAddress = await rocketStorage.getAddress(
    ethers.utils.keccak256(ethers.utils.toUtf8Bytes("contract.addressrocketNetworkBalances")))
  const balancesABI = JSON.parse(await fs.readFile('balancesABI.json', 'utf-8'))
  const balancesContract = new ethers.Contract(balancesAddress, balancesABI, provider)
  console.log('creating filter')
  const filter = balancesContract.filters.BalancesUpdated()
  console.log('retrieving events')
  const fromBlock = options.fromBlock && ethers.BigNumber.from(options.fromBlock).toHexString()
  const toBlock = options.toBlock && ethers.BigNumber.from(options.toBlock).toHexString()
  const events = await balancesContract.queryFilter(filter, fromBlock, toBlock)
  console.log('reducing to args')
  const args = events.map(e => e.args)
  console.log('sorting args')
  args.sort((a, b) => a[0].lt(b[0]) ? -1 : a[0].gt(b[0]) ? 1 : 0)
  console.log(`appending to ${options.file}`)
  await fs.writeFile(options.file, args.map(l => JSON.stringify(l.map(n => n.toHexString()))).join('\n').concat('\n'), {flag: 'a'})
})()
