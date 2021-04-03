import { test } from '@agoric/swingset-vat/tools/prepare-test-env-ava';

import { E } from '@agoric/eventual-send';
import {
  makeNetworkProtocol,
  makeLoopbackProtocolHandler,
} from '@agoric/swingset-vat/src/vats/network';

import bundleSource from '@agoric/bundle-source';
import { makeLocalAmountMath } from '@agoric/ertp';
import { makeZoe } from '@agoric/zoe';

import fakeVatAdmin from '@agoric/zoe/src/contractFacet/fakeVatAdmin';

const contractPath = `${__dirname}/../src/pegasus`;

/**
 * @param {import('tape-promise/tape').Test} t
 */
async function testRemotePeg(t) {
  t.plan(8);

  /**
   * @type {import('@agoric/ertp').DepositFacet?}
   */
  let localDepositFacet;
  const board = harden({
    getValue(id) {
      t.is(id, '0x1234', 'got the deposit-only facet');
      return localDepositFacet;
    },
  });

  const zoe = makeZoe(fakeVatAdmin);

  // Pack the contract.
  const contractBundle = await bundleSource(contractPath);
  const installationHandle = await E(zoe).install(contractBundle);

  const { publicFacet: publicAPI } = await E(zoe).startInstance(
    installationHandle,
    {},
    { board },
  );

  /**
   * @type {import('../src/pegasus').Pegasus}
   */
  const pegasus = publicAPI;
  const network = makeNetworkProtocol(makeLoopbackProtocolHandler(E));

  const portP = E(network).bind('/ibc-channel/chanabc/ibc-port/portdef');
  const portName = await E(portP).getLocalAddress();

  /**
   * Pretend we're Gaia.
   * @type {import('@agoric/swingset-vat/src/vats/network').Connection?}
   */
  let gaiaConnection;
  E(portP).addListener({
    async onAccept(_p, _localAddr, _remoteAddr) {
      return harden({
        async onOpen(c) {
          gaiaConnection = c;
        },
        async onReceive(_c, packetBytes) {
          const packet = JSON.parse(packetBytes);
          t.deepEqual(
            packet,
            {
              amount: '100000000000000000001',
              denomination: 'portdef/chanabc/uatom',
              receiver: 'markaccount',
            },
            'expected transfer packet',
          );
          return JSON.stringify({ success: true });
        },
      });
    },
  });

  // Pretend we're Agoric.
  const chandler = E(pegasus).makePegConnectionHandler();
  const connP = E(portP).connect(portName, chandler);

  const pegP = await E(pegasus).pegRemote('Gaia', connP, 'uatom');
  const localBrand = await E(pegP).getLocalBrand();
  const localIssuer = await E(pegasus).getLocalIssuer(localBrand);

  const localPurseP = E(localIssuer).makeEmptyPurse();
  localDepositFacet = await E(localPurseP).getDepositFacet();

  // Get some local Atoms.
  const sendPacket = {
    amount: '100000000000000000001',
    denomination: 'portdef/chanabc/uatom',
    receiver: '0x1234',
    sender: 'FIXME:sender',
  };

  const sendAckData = await E(gaiaConnection).send(JSON.stringify(sendPacket));
  const sendAck = JSON.parse(sendAckData);
  t.deepEqual(sendAck, { success: true }, 'Gaia sent the atoms');
  if (!sendAck.success) {
    console.log(sendAckData, sendAck.error);
  }

  const localAtomsAmount = await E(localPurseP).getCurrentAmount();
  t.deepEqual(
    localAtomsAmount,
    { brand: localBrand, value: 100000000000000000001n },
    'we received the shadow atoms',
  );

  const localAtoms = await E(localPurseP).withdraw(localAtomsAmount);

  const allegedName = await E(pegP).getAllegedName();
  t.is(allegedName, 'Gaia', 'alleged peg name is equal');
  const transferInvitation = await E(pegasus).makeInvitationToTransfer(
    pegP,
    'markaccount',
  );
  const seat = await E(zoe).offer(
    transferInvitation,
    harden({
      give: { Transfer: localAtomsAmount },
    }),
    harden({ Transfer: localAtoms }),
  );
  const outcome = await seat.getOfferResult();
  t.is(await outcome, undefined, 'transfer is successful');

  const paymentPs = await seat.getPayouts();
  const refundAmount = await E(localIssuer).getAmountOf(paymentPs.Transfer);

  const isEmptyRefund = await E(makeLocalAmountMath(localIssuer)).isEmpty(
    refundAmount,
  );
  t.assert(isEmptyRefund, 'no refund from success');

  const stillIsLive = await E(localIssuer).isLive(localAtoms);
  t.assert(!stillIsLive, 'payment is consumed');
}

test('remote peg', t =>
  testRemotePeg(t).catch(err => t.not(err, err, 'unexpected exception')));
