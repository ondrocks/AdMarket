import { assert } from 'chai'
import p from 'es6-promisify'
import Web3 from 'web3'
import MerkleTree, { checkProof, merkleRoot } from 'merkle-tree-solidity'
import { sha3 } from 'ethereumjs-util'
import setup from '../setup'
import { parseChannel, getFingerprint, getRoot, solSha3, parseLogAddress,
  verifySignature, makeUpdate, verifyUpdate, parseBN } from '../channel'
import { wait } from '../utils'

jasmine.DEFAULT_TIMEOUT_INTERVAL = 30000

const web3 = new Web3()

// goal - usable node.js middleware library for impression tracking
// ACF will be registrar first and operate adMarket first
// need to test out what auditing looks like
// reference implementation. 2 weeks till completion.
// offchain storage combines with this.
// need to manage state machine between both nodes, interaction with adMarket

describe('AdMarket', async () => {

  let adMarket, eth, accounts, web3
  let snapshotId, filter

  beforeAll(async () => {
    let result = await setup({ testRPCProvider: 'http://localhost:8545'})
    adMarket = result.adMarket
    eth = result.eth
    accounts = result.accounts
    web3 = result.web3
  })

  beforeEach(async () => {
    let res = await p(web3.currentProvider.sendAsync.bind(web3.currentProvider))({
      jsonrpc: '2.0',
      method: 'evm_snapshot',
      id: new Date().getTime()
    })
    snapshotId = res.result
    filter = web3.eth.filter({ address: adMarket.address, fromBlock: 0 })
  })

  afterEach(async () => {
    await p(filter.stopWatching.bind(filter))()
    await p(web3.currentProvider.sendAsync.bind(web3.currentProvider))({
      jsonrpc: '2.0',
      method: 'evm_revert',
      params: [snapshotId],
      id: new Date().getTime()
    })
  })

  it('setup', async () => {
    // channelCount should start at 0
    const channelCount = await adMarket.channelCount()
    assert.equal(+channelCount[0].toString(), 0)
  })

  it('registerDemand', async () => {
    const demand = accounts[1]
    const url = 'foo'
    await adMarket.registerDemand(demand, url)
    const result = await adMarket.registeredDemand(demand)
    assert.equal(result[0], url)

    const logs = await p(filter.get.bind(filter))()
    const logAddress = parseLogAddress(logs[0].topics[1])
    assert.equal(logAddress, demand)
  })

  it('registerSupply', async () => {
    const supply = accounts[1]
    const url = 'foo'
    await adMarket.registerSupply(supply, url)
    const result = await adMarket.registeredSupply(supply)
    assert.equal(result[0], url)

    const logs = await p(filter.get.bind(filter))()
    const logAddress = parseLogAddress(logs[0].topics[1])
    assert.equal(logAddress, supply)
  })

  it('deregisterDemand', async () => {
    const demand = accounts[1]
    const url = 'foo'
    await adMarket.registerDemand(demand, url)
    await adMarket.deregisterDemand(demand)
    const result = await adMarket.registeredDemand(demand)
    assert.equal(result[0], '')

    const logs = await p(filter.get.bind(filter))()
    const logAddress = parseLogAddress(logs[1].topics[1])
    assert.equal(logAddress, demand)
  })

  it('deregisterSupply', async () => {
    const supply = accounts[1]
    const url = 'foo'
    await adMarket.registerSupply(supply, url)
    await adMarket.deregisterSupply(supply)
    const result = await adMarket.registeredSupply(supply)
    assert.equal(result[0], '')

    const logs = await p(filter.get.bind(filter))()
    const logAddress = parseLogAddress(logs[1].topics[1])
    assert.equal(logAddress, supply)
  })

  it('updateDemandUrl', async () => {
    const demand = accounts[1]
    const url = 'foo'
    await adMarket.registerDemand(demand, url)
    await adMarket.updateDemandUrl('bar', { from: demand })
    const result = await adMarket.registeredDemand(demand)
    assert.equal(result[0], 'bar')

    const logs = await p(filter.get.bind(filter))()
    const logAddress = parseLogAddress(logs[1].topics[1])
    assert.equal(logAddress, demand)
  })

  it('updateSupplyUrl', async () => {
    const supply = accounts[1]
    const url = 'foo'
    await adMarket.registerSupply(supply, url)
    await adMarket.updateSupplyUrl('bar', { from: supply })
    const result = await adMarket.registeredSupply(supply)
    assert.equal(result[0], 'bar')

    const logs = await p(filter.get.bind(filter))()
    const logAddress = parseLogAddress(logs[1].topics[1])
    assert.equal(logAddress, supply)
  })

  it('openChannel', async () => {
    const demand = accounts[1]
    const supply = accounts[2]
    const demandUrl = 'foo'
    const supplyUrl = 'bar'
    const channelId = solSha3(0)
    await adMarket.registerDemand(demand, demandUrl)
    await adMarket.registerSupply(supply, supplyUrl)

    const blockNumber = await p(web3.eth.getBlockNumber.bind(web3.eth))()
    const channelTimeout = parseBN((await p(adMarket.channelTimeout)())[0])
    const expiration = blockNumber + channelTimeout + 1

    await adMarket.openChannel(supply, { from: demand })

    const channel = parseChannel(await adMarket.getChannel(channelId))

    assert.equal(channel.contractId, adMarket.address)
    assert.equal(channel.channelId, channelId)
    assert.equal(channel.demand, demand)
    assert.equal(channel.supply, supply)
    assert.equal(parseInt(channel.root, 16), 0)
    assert.equal(channel.state, 0)
    assert.equal(channel.expiration, expiration)
    assert.equal(channel.challengeTimeout, 0)
    assert.equal(parseInt(channel.proposedRoot, 16), 0)
  })

  it('proposeCheckpointChannel', async () => {
    const demand = accounts[1]
    const supply = accounts[2]
    const demandUrl = 'foo'
    const supplyUrl = 'bar'
    const channelId = solSha3(0)
    await adMarket.registerDemand(demand, demandUrl)
    await adMarket.registerSupply(supply, supplyUrl)
    await adMarket.openChannel(supply, { from: demand })
    const channel = parseChannel(await adMarket.getChannel(channelId))

    const blockNumber = await p(web3.eth.getBlockNumber.bind(web3.eth))()
    const challengePeriod = parseBN((await p(adMarket.challengePeriod)())[0])
    const challengeTimeout = blockNumber + challengePeriod + 1

    const proposedRoot = solSha3('wut')
    channel.root = proposedRoot
    const fingerprint = getFingerprint(channel)
    const sig = await p(web3.eth.sign)(demand, fingerprint)
    await adMarket.proposeCheckpointChannel(
      channelId, proposedRoot, sig, { from: demand }
    )

    const updatedChannel = parseChannel(await adMarket.getChannel(channelId))
    assert.equal(updatedChannel.state, 1)
    assert.equal(updatedChannel.challengeTimeout, challengeTimeout)
    assert.equal(updatedChannel.proposedRoot, proposedRoot)
  })

  xit('challengeCheckpointChannel', async () => {
    const demand = accounts[1]
    const supply = accounts[2]
    const demandUrl = 'foo'
    const supplyUrl = 'bar'
    await adMarket.registerDemand(demand, demandUrl)
    await adMarket.registerSupply(supply, supplyUrl)
    await adMarket.openChannel(supply, { from: demand })
    const channel = parseChannel(await adMarket.getChannel(channelId))

    // todo make channel

    const input = {
      impressionId: web3.sha3('bar'),
      impressionPrice: 2
    }
  })

  it('verifySignature', async () => {
    const channel = {
      contractId: '0x12345123451234512345',
      channelId: web3.sha3('foo'),
      demand: '0x11111111111111111111',
      supply: '0x22222222222222222222',
      impressionId: 'foo',
      impressionPrice: 1,
      impressions: 1000,
      balance: 1000
    }

    channel.root = getRoot(channel, web3.sha3('foo'))

    const fingerprint = getFingerprint(channel)
    const sig = await p(web3.eth.sign)(accounts[0], fingerprint)
    assert.ok(verifySignature(channel, sig, accounts[0]))
  })
})

  // TODO test Join edge cases

  /*
  it('checkpoint', async () => {
    await adMarket.open()

    await adMarket.join(1, {
      from: accounts[1],
      value: 1000
    })

    let state = parseChannel(await adMarket.getChannel(1))
    state.balances = [1, 999]
    state.sequenceNumber += 1

    const data = 'hello world'

    // TODO need a better merkling strategy
    await p(trie.put.bind(trie))(0, state.root)
    await p(trie.put.bind(trie))(1, data)

    state.root = '0x'+trie.root.toString('hex')

    const fingerprint = getFingerprint(state)

    const sig0 = await p(web3.eth.sign)(accounts[0], fingerprint)
    const sig1 = await p(web3.eth.sign)(accounts[1], fingerprint)

    await adMarket.checkpoint(
      state.channelId,
      state.participants,
      state.balances,
      state.root,
      state.sequenceNumber,
      sig0,
      sig1
    )

    const saved = parseChannel(await adMarket.getChannel(1))

    assert.equal(saved.balances[0], state.balances[0])
    assert.equal(saved.balances[1], state.balances[1])
    assert.equal(saved.root, state.root)
    assert.equal(saved.sequenceNumber, state.sequenceNumber)
  })
  */

function makeString (char, length) {
  let string = ''
  for (let i = 0; i < length; i++) {
    string += char
  }
  return string
}

function range (max) {
  const arr = []
  for (let i = 0; i < max; i++) {
    arr.push(i + 1)
  }
  return arr
}
