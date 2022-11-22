#!/usr/bin/env node

const { program } = require('commander')
const ethers = require('ethers')
const fs = require('fs/promises')

const rocketStorageAddress = '0x1d8f8f00cfa6758d7bE78336684788Fb0ee0Fa46'

program.option('-r, --rpc <url>', 'Full node RPC endpoint URL', 'http://localhost:8545')
       .option('-a, --account <addr>', 'Address of the account to calculate yields for')
       .option('-b, --balances-file <file>', 'File containing lines of balances data', 'balances.jsonl')
program.parse()
const options = program.opts()

const oneEther = ethers.utils.parseUnits('1', 'ether')

const provider = new ethers.providers.JsonRpcProvider(options.rpc)

const state = {
  account: undefined,
  ethInProtocol: ethers.BigNumber.from(0),
  rethInAccount: ethers.BigNumber.from(0)
}

const fu = ethers.utils.formatUnits

function fur(n, dps, digits) {
  dps = dps || 3
  digits = digits || 4
  const sh = 10 ** (18 - dps)
  const [x, y] = ethers.utils.formatUnits(n.div(sh).mul(sh)).split('.')
  return [x.padStart(digits, ' '), y.padEnd(dps, '0')].join('.')
}

let balancesLines

function getBalances(blockNumber) {
  if (balancesLines.at(-1)[0].lt(blockNumber)) {
    console.log('Warning: may need to update balances - using last available')
    return balancesLines.at(-1)
  }
  if (balancesLines.at(0)[0].gt(blockNumber)) {
    console.log('Error: requested block before first balances')
    process.exit(1)
  }
  let a = ethers.BigNumber.from(0)
  let b = ethers.BigNumber.from(balancesLines.length)
  while (b.sub(a).gt(1)) {
    let m = a.add(b.sub(a).div(2))
    if (balancesLines[m.toNumber()][0].gt(blockNumber))
      b = m
    else a = m
  }
  return balancesLines[a.toNumber()]
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

// BalancesUpdated(block, totalEth, stakingEth, rethSupply, time)
// Transfer(from, to, value)

async function processEvent(e) {
  const blockNumber = e.blockNumber
  const [balancesBlock, totalEth, , rethSupply] = getBalances(blockNumber)
  const exchangeRate = oneEther.mul(totalEth).div(rethSupply)
  const block = await provider.getBlock(blockNumber.toHexString())
  const timestamp = block.timestamp
  const date = new Date(timestamp * 1000)
  const line = [e.transactionHash, formatDate(date)]
  if (e.event === 'Transfer') {
    const [from, to, amount] = e.args
    const tx = await provider.getTransaction(e.transactionHash)
    if (from === state.account) {
      line.push(`-> ${fur(amount)} rETH`)
      line.push(`Rate@${balancesBlock.toString()}: ${fur(exchangeRate, 4, 1)}`)
      const ethAmount = exchangeRate.mul(amount).div(oneEther)
      line.push(`<- ${fur(ethAmount)} ETH`)
      state.rethInAccount = state.rethInAccount.sub(amount)
      state.ethInProtocol = state.ethInProtocol.sub(ethAmount)
    }
    else if (to === state.account) {
      line.push(`<- ${fur(amount)} rETH`)
      line.push(`Rate@${balancesBlock.toString()}: ${fur(exchangeRate, 4, 1)}`)
      const ethAmount = exchangeRate.mul(amount).div(oneEther)
      line.push(`-> ${fur(ethAmount)} ETH`)
      state.rethInAccount = state.rethInAccount.add(amount)
      state.ethInProtocol = state.ethInProtocol.add(ethAmount)
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

;(async () => {
  const rocketStorage = new ethers.Contract(
    rocketStorageAddress, ["function getAddress(bytes32 key) view returns (address)"], provider)
  const rethAddress = await rocketStorage.getAddress(
    ethers.utils.keccak256(ethers.utils.toUtf8Bytes("contract.addressrocketTokenRETH")))
  const rethABI = JSON.parse(await fs.readFile('rethABI.json', 'utf-8'))
  const rethContract = new ethers.Contract(rethAddress, rethABI, provider)

  balancesLines = (await fs.readFile(options.balancesFile, 'utf-8')).split('\n').slice(0,-1).map(l => JSON.parse(l).map(ethers.BigNumber.from))
  console.log(`Got ${balancesLines.length} balances lines`)

  state.account = await provider.resolveName(options.account) || options.account
  console.log(`rETH tracking for ${state.account}`)

  const sendFilter = rethContract.filters.Transfer(state.account)
  const recvFilter = rethContract.filters.Transfer(null, state.account)

  console.log('Retrieving send events')
  const sendEvents = await rethContract.queryFilter(sendFilter)
  console.log('Retrieving receive events')
  const recvEvents = await rethContract.queryFilter(recvFilter)

  console.log('Sorting events')
  const events = sendEvents.concat(recvEvents).map(e => ({...e, blockNumber: ethers.BigNumber.from(e.blockNumber)}))
  events.sort((a, b) => a.blockNumber.lte(b.blockNumber) ? -1 : 1)

  console.log('Processing events');
  (await Promise.all(events.map(processEvent))).forEach(l => console.log(l))

  if (state.rethInAccount.eq(0)) {
    console.log(`No rETH in account`)
    return
  }

  console.log('Calculating return')
  const primaryRate = await rethContract.getExchangeRate()
  const accountRate = oneEther.mul(state.ethInProtocol).div(state.rethInAccount)
  console.log(`Net balance: ${fu(state.rethInAccount)} rETH acquired at a cost of ${fu(state.ethInProtocol)} ETH`)
  console.log(`Account rETH price: ${fu(accountRate)} ETH`)
  console.log(`Current rETH price: ${fu(primaryRate)} ETH`)
  const currentValue = state.rethInAccount.mul(primaryRate).div(oneEther)
  console.log(`${fu(currentValue)} ETH's worth of rETH acquired for the above cost`)
  console.log(`Staking return: ${fu(currentValue.sub(state.ethInProtocol))} ETH`)
})()
