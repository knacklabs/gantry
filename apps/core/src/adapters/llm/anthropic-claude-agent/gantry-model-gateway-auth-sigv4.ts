import { createHash, createHmac } from 'node:crypto';

export interface AwsSigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface AwsSigV4SignInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Buffer;
  region: string;
  service: string;
  credentials: AwsSigV4Credentials;
  now?: Date;
}

export function signAwsSigV4Request(input: AwsSigV4SignInput): void {
  const now = input.now ?? new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const bodyHash = sha256Hex(input.body);
  const host = input.url.host;

  input.headers.host = host;
  input.headers['x-amz-date'] = amzDate;
  input.headers['x-amz-content-sha256'] = bodyHash;
  if (input.credentials.sessionToken) {
    input.headers['x-amz-security-token'] = input.credentials.sessionToken;
  }

  const { canonicalHeaders, signedHeaders } = canonicalizeHeaders(
    input.headers,
  );
  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(input.url),
    canonicalQuery(input.url),
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(Buffer.from(canonicalRequest, 'utf8')),
  ].join('\n');
  const signingKey = awsSigV4SigningKey(
    input.credentials.secretAccessKey,
    dateStamp,
    input.region,
    input.service,
  );
  const signature = hmacHex(signingKey, stringToSign);
  input.headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function canonicalizeHeaders(headers: Record<string, string>): {
  canonicalHeaders: string;
  signedHeaders: string;
} {
  const pairs = Object.entries(headers)
    .map(([key, value]) => [
      key.toLowerCase(),
      value.replace(/\s+/g, ' ').trim(),
    ])
    .sort(([left], [right]) => byteOrder(left, right));
  return {
    canonicalHeaders: pairs.map(([key, value]) => `${key}:${value}\n`).join(''),
    signedHeaders: pairs.map(([key]) => key).join(';'),
  };
}

function canonicalUri(url: URL): string {
  return url.pathname || '/';
}

function canonicalQuery(url: URL): string {
  const rawQuery = url.search.startsWith('?')
    ? url.search.slice(1)
    : url.search;
  if (!rawQuery) return '';
  return rawQuery
    .split('&')
    .map((part) => {
      const separator = part.indexOf('=');
      const rawKey = separator === -1 ? part : part.slice(0, separator);
      const rawValue = separator === -1 ? '' : part.slice(separator + 1);
      return [
        encodeRfc3986(decodeRawQueryPart(rawKey)),
        encodeRfc3986(decodeRawQueryPart(rawValue)),
      ] as const;
    })
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      const keyOrder = byteOrder(leftKey, rightKey);
      return keyOrder || byteOrder(leftValue, rightValue);
    })
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function byteOrder(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function awsSigV4SigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const dateKey = hmacBuffer(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmacBuffer(dateKey, region);
  const serviceKey = hmacBuffer(regionKey, service);
  return hmacBuffer(serviceKey, 'aws4_request');
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function sha256Hex(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmacBuffer(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function hmacHex(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function decodeRawQueryPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
