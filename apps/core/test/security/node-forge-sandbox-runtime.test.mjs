import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect as connectTls, createServer } from 'node:tls';
import { after, test } from 'node:test';

import {
  createMitmCA,
  disposeMitmCA,
} from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js';
import {
  mintLeafCert,
  secureContextFor,
} from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-leaf.js';

const require = createRequire(import.meta.url);
const forge = require('node-forge');
const packageMetadata = require('node-forge/package.json');
const packageRoot = new URL('../../../../node_modules/node-forge/', import.meta.url);
const ca = createMitmCA({});
const vulnerabilityModulus =
  'E932AC92252F585B3A80A4DD76A897C8B7652952FE788F6EC8DD640587A1EE56' +
  '47670A8AD4C2BE0F9FA6E49C605ADF77B5174230AF7BD50E5D6D6D6D28CCF0A8' +
  '86A514CC72E51D209CC772A52EF419F6A953F3135929588EBE9B351FCA61CED7' +
  '8F346FE00DBB6306E5C2A4C6DFC3779AF85AB417371CF34D8387B9B30AE46D7A' +
  '5FF5A655B8D8455F1B94AE736989D60A6F2FD5CADBFFBD504C5A756A2E6BB5CE' +
  'CC13BCA7503F6DF8B52ACE5C410997E98809DB4DC30D943DE4E812A47553DCE5' +
  '4844A78E36401D13F77DC650619FED88D8B3926E3D8E319C80C744779AC5D6AB' +
  'E252896950917476ECE5E8FC27D5F053D6018D91B502C4787558A002B9283DA7';
const vulnerabilityPublicKey = forge.pki.rsa.setPublicKey(
  new forge.jsbn.BigInteger(vulnerabilityModulus, 16),
  new forge.jsbn.BigInteger('3'),
);
const malformedSignatures = [
  // Extra element in the inner DigestAlgorithm sequence.
  '3408bdfaeca12b29c6ac284f95aca731a14f9c06125cca16d54ae0cc3f6fe6ff0005425b3dcd8122ef4c94781556a3d174f72e1cd5df0c79aed2d0b617fdd52ec430eae767873065d9a770c57b8c451775afe3bdc0bb86ff4d9319d2008548ae653308ba32be9b456710e7e04cc39232db5794b06afa95eed00697d32efd346155fd483ec1709c281aeb4253c967494fe4f30be67bacb0b41f343d1c767e808b6370039d16b7c13a7921965c37062ddca94cc519c4569e5a8abf5245886e3b6deb8224994db79f7189da3090bf50d3bdd4257f472aeafae7240db7ed40e5583588305d94d61e24e7749b2225b8e3c0c793f94a0a6cd4907e6f35cd20ead3be37',
  // Non-NULL second element in the inner sequence.
  '949824e00859dfb3b773511c7154655f0ec8d00ac794a90149a675d03f507418d695d41e7f05a164a6da6f06a7f4ecf9ef32be436ecb55856dd6fad5b30ac9583b165843a0d7b6e9fd64446370683c89c0bb3329a766b6caf77379e4ff9b62cd0e11f7cdd9598678a86bbcb84e4323ed2dac268df54861d9b6d2d92699ce85a6f2c5170d293ea218ee3d386cfb9980191903428618150b9136b266c664635979968f7dfaf3ecd18dfb894c9681794099b86cfe76d7110b258284744d21b1822b0d97793e6e7f4335807b18366037c7a70d42a6f8519194168db0d7dca805084b7808df9cc831ba2036708e77ca7a0b9753a2043925d897a5b0dbf4db6b46a74a',
  // NULL parameters carrying content bytes.
  '6cbe22adc4ee40e1d0feb9610bb0dbff668920486cb702f97c5facbbca980bf9b7130378f9c26f48dcaa6f6aee893880a2bba807ceae692f1db84510e0b1bdf91516ae082e9fdce6cc894b9a71da05da94eb67b2e66b7ac624737a9062619860cda4325bab5618749e865f6b234f480b4f34c6eedf980109d5706090da9a6ab98e51da2657908cfdf624526eccf531918f3af0f8c277b1bc22285048c39e1628b4c4f9345ac388bfa622577dc2e1c00ea53cbcdecaf06ea647ad690801d2ba40665ec4a03ec89364a04456e66b49d99c2b7256cf55e0273d1875efef5214bf35c5d833d0e542dac41abf0292852e5078f5af0018318687afed57b953ca49674f',
  // Non-minimal inner and outer DER length encodings.
  '4f818f8bcdd0933f8016b285fad842a79e7a6580b0186703e5aa2fea9b438034258698f1a0964f59647ebcfd3a151abeed5c6632a416e5439a4cdfb1e01f43e16f6e310369a15006d9838efaade707e81b812d4968d0585e9536ccd5d9511301644fbcd307f2abc6e8aefdd642d076f3afd7a9669e3e7b84c17fe2cf46ae7e261742f8e626d5323eaa3eb5d613e568024a671d6b740d523ab7f856dec0b3151ab9e7115daff812a966f56d745941aa1fc15a320df759f690998d4afbe2649876f3f68fb9104dbfc26b7d9af4248bc15a2aa2fd7aaa47eb72ae01b231915b652a68ab0bca1646e48933be3b260a0227906c4812e0dd2f165014c27abacea9c7ac',
];
const parameterlessValidSignature =
  'a0073057133ff3758e7e111b4d7441f1d8cbe4b2dd5ee4316a14264290dee5ed7f175716639bd9bb43a14e4f9fcb9e84dedd35e2205caac04828b2c053f68176d971ea88534dd2eeec903043c3469fc69c206b2a8694fd262488441ed8852280c3d4994e9d42bd1d575c7024095f1a20665925c2175e089c0d731471f6cc145404edf5559fd2276e45e448086f71c78d0cc6628fad394a34e51e8c10bc39bfe09ed2f5f742cc68bee899d0a41e4c75b7b80afd1c321d89ccd9fe8197c44624d91cc935dfa48de3c201099b5b417be748aef29248527e8bbb173cab76b48478d4177b338fe1f1244e64d7d23f07add560d5ad50b68d6649a49d7bc3db686daaa7';

after(async () => {
  await disposeMitmCA(ca);
});

test('materializes the guarded Node entry without an unpatched browser bundle', () => {
  assert.equal(packageMetadata.name, 'node-forge');
  assert.equal(packageMetadata.version, '1.4.0');
  assert.match(require.resolve('node-forge'), /node-forge\/lib\/index\.js$/);
  assert.equal(existsSync(new URL('dist', packageRoot)), false);
});

test('verifies SHA-256, SHA-384, and SHA-512 signatures for common RSA exponents', () => {
  for (const exponent of [3, 65537]) {
    const keyPair = forge.pki.rsa.generateKeyPair({ bits: 1024, e: exponent });

    for (const algorithm of ['sha256', 'sha384', 'sha512']) {
      const signerDigest = forge.md[algorithm].create();
      signerDigest.update(`gantry-${algorithm}-${exponent}`, 'utf8');
      const signature = keyPair.privateKey.sign(signerDigest);

      const verifierDigest = forge.md[algorithm].create();
      verifierDigest.update(`gantry-${algorithm}-${exponent}`, 'utf8');
      assert.equal(
        keyPair.publicKey.verify(verifierDigest.digest().bytes(), signature),
        true,
      );
    }
  }
});

test('rejects the upstream malformed DigestInfo fixtures', () => {
  for (const signatureHex of malformedSignatures) {
    const digest = forge.md.sha256.create();
    digest.update('hello world!');

    assert.throws(
      () =>
        vulnerabilityPublicKey.verify(
          digest.digest().getBytes(),
          forge.util.hexToBytes(signatureHex),
          undefined,
          { _parseAllDigestBytes: true, _skipPaddingChecks: true },
        ),
      /ASN\.1 object does not contain a valid RSASSA-PKCS1-v1_5 DigestInfo value/,
    );
  }
});

test('accepts the upstream parameter-less DigestInfo fixture', () => {
  const digest = forge.md.sha256.create();
  digest.update('hello world!');

  assert.equal(
    vulnerabilityPublicKey.verify(
      digest.digest().getBytes(),
      forge.util.hexToBytes(parameterlessValidSignature),
      undefined,
      { _parseAllDigestBytes: true, _skipPaddingChecks: true },
    ),
    true,
  );
});

test('sandbox-runtime mints a trusted leaf and completes a TLS handshake', async () => {
  const hostname = 'sandbox-runtime.test';
  const leaf = mintLeafCert(ca, hostname);
  assert.ok(secureContextFor(ca, hostname));

  const server = createServer({ cert: leaf.certPem, key: leaf.keyPem }, socket => {
    socket.end('ok');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    assert.equal(typeof address, 'object');

    const response = await new Promise((resolve, reject) => {
      const socket = connectTls({
        ca: ca.certPem,
        host: '127.0.0.1',
        port: address.port,
        rejectUnauthorized: true,
        servername: hostname,
      });
      let body = '';
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        body += chunk;
      });
      socket.once('end', () => resolve(body));
      socket.once('error', reject);
    });

    assert.equal(response, 'ok');
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
  }
});
