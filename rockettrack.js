#!/usr/bin/env node

import { program } from 'commander'
import { ethers } from 'ethers'
import fs from 'fs/promises'

const rocketStorageAddress = '0x1d8f8f00cfa6758d7bE78336684788Fb0ee0Fa46'

const collectBundle = (value, previous) => previous.concat([value])

program.option('-r, --rpc <url>', 'Full node RPC endpoint URL', 'http://localhost:8545')
       .option('-a, --account <addr>', 'Address of the account to calculate yields for', collectBundle, [])
       .option('--block <num>', 'Just get exchange rate at latest block no later than this block')
       .option('-b, --balances-file <file>', 'File containing lines of balances data', 'balances.jsonl')
program.parse()
const options = program.opts()

const oneEther = ethers.parseUnits('1', 'ether')

const provider = new ethers.JsonRpcProvider(options.rpc)

const state = {
  account: undefined,
  ethInProtocol: 0n,
  rethInAccount: 0n
}

const fu = ethers.formatUnits

function fur(n, dps, digits) {
  dps = dps || 3
  digits = digits || 4
  const sh = 10n ** (18n - BigInt(dps))
  const [x, y] = ethers.formatUnits((n / sh) * sh).split('.')
  return [x.padStart(digits, ' '), y.padEnd(dps, '0')].join('.')
}

let balancesLines

function getBalances(blockNumber) {
  if (balancesLines.at(-1)[0] < blockNumber) {
    console.log('Warning: may need to update balances - using last available')
    return balancesLines.at(-1)
  }
  if (balancesLines.at(0)[0] > blockNumber) {
    console.log('Error: requested block before first balances')
    process.exit(1)
  }
  let a = 0n
  let b = BigInt(balancesLines.length)
  while (b - a > 1n) {
    let m = a + ((b - a) / 2n)
    if (balancesLines[parseInt(m)][0] > blockNumber)
      b = m
    else a = m
  }
  return balancesLines[parseInt(a)]
}

const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function formatDate(date) {
  const a = []
  a.push(`${date.getUTCDate().toString().padStart(2,'0')}/${months[date.getUTCMonth()]}/${date.getUTCFullYear()}`)
  const t = [
    date.getUTCHours().toString().padStart(2,'0'),
    date.getUTCMinutes().toString().padStart(2,'0'),
    date.getUTCSeconds().toString().padStart(2,'0')]
  a.push(t.join(':'))
  return a.join(' ')
}

// BalancesUpdated(block, slotTimestamp, totalEth, stakingEth, rethSupply, time)
// Transfer(from, to, value)

const ignored = new Set()

async function processEvent(e) {
  const blockNumber = e.blockNumber
  const [balancesBlock, , totalEth, , rethSupply] = getBalances(blockNumber)
  const exchangeRate = oneEther * totalEth / rethSupply
  const block = await provider.getBlock(blockNumber)
  const timestamp = block.timestamp
  const date = new Date(timestamp * 1000)
  const line = [e.transactionHash, formatDate(date)]
  if (e.eventName === 'Transfer') {
    const [from, to, amount] = e.args
    const tx = await provider.getTransaction(e.transactionHash)
    if (state.account.includes(to) && state.account.includes(from)) {
      if (!ignored.has(e.transactionHash)) {
        console.log(`Ignoring inter-account transaction ${line[0]} ${line[1]} ${fur(amount)} rETH`)
        ignored.add(e.transactionHash)
      }
      line.length = 0
    }
    else if (state.account.includes(from)) {
      line.push(`-> ${fur(amount)} rETH`)
      line.push(`Rate@${balancesBlock.toString()}: ${fur(exchangeRate, 4, 1)}`)
      const ethAmount = exchangeRate * amount / oneEther
      line.push(`<- ${fur(ethAmount)} ETH`)
      state.rethInAccount = state.rethInAccount - amount
      state.ethInProtocol = state.ethInProtocol - ethAmount
    }
    else if (state.account.includes(to)) {
      line.push(`<- ${fur(amount)} rETH`)
      line.push(`Rate@${balancesBlock.toString()}: ${fur(exchangeRate, 4, 1)}`)
      const ethAmount = exchangeRate * amount / oneEther
      line.push(`-> ${fur(ethAmount)} ETH`)
      state.rethInAccount = state.rethInAccount + amount
      state.ethInProtocol = state.ethInProtocol + ethAmount
    }
    else {
      console.log(`Error: ${e.transactionHash} Transfer from/to wrong account: ${from}/${to}`)
    }
  }
  else {
    console.log(`Error: ${e.transactionHash} Unknown event: ${e.event}`)
  }
  return line.join(' ')
}

const rocketStorage = new ethers.Contract(
  rocketStorageAddress, ["function getAddress(bytes32 key) view returns (address)"], provider)
const rethAddress = await rocketStorage['getAddress(bytes32)'](ethers.id("contract.addressrocketTokenRETH"))
const rethABI = JSON.parse(await fs.readFile('rethABI.json', 'utf-8'))
const rethContract = new ethers.Contract(rethAddress, rethABI, provider)

balancesLines = (await fs.readFile(options.balancesFile, 'utf-8')).split('\n').slice(0,-1).map(l => JSON.parse(l).map(BigInt))
console.log(`Got ${balancesLines.length} balances lines`)

if (options.block) {
  const [balancesBlock, , totalEth, , rethSupply] = getBalances(parseInt(options.block))
  const exchangeRate = oneEther * totalEth / rethSupply
  console.log(`At ${balancesBlock} exchange rate: ${exchangeRate} (${fur(exchangeRate, 4, 1)})`)
  process.exit()
}

state.account = await Promise.all(
  options.account.map(async x => await provider.resolveName(x) || x)
)
console.log(`rETH tracking for ${state.account}`)

const sendFilter = rethContract.filters.Transfer(state.account)
const recvFilter = rethContract.filters.Transfer(null, state.account)

console.log('Retrieving send events')
const sendEvents = await rethContract.queryFilter(sendFilter)
console.log('Retrieving receive events')
const recvEvents = await rethContract.queryFilter(recvFilter)

console.log('Sorting events')
const events = sendEvents.concat(recvEvents)
events.sort((a, b) => a.blockNumber <= b.blockNumber ? -1 : 1)

console.log('Processing events');
(await Promise.all(events.map(processEvent))).forEach(l => l && console.log(l))

if (state.rethInAccount == 0n) {
  console.log(`No rETH in account`)
}
else {
  console.log('Calculating return')
  const primaryRate = await rethContract.getExchangeRate()
  const accountRate = oneEther * state.ethInProtocol / state.rethInAccount
  console.log(`Net balance: ${fu(state.rethInAccount)} rETH acquired at a cost of ${fu(state.ethInProtocol)} ETH`)
  console.log(`Account rETH price: ${fu(accountRate)} ETH`)
  console.log(`Current rETH price: ${fu(primaryRate)} ETH`)
  const currentValue = state.rethInAccount * primaryRate / oneEther
  console.log(`${fu(currentValue)} ETH's worth of rETH acquired for the above cost`)
  console.log(`Staking return: ${fu(currentValue - state.ethInProtocol)} ETH`)
}
