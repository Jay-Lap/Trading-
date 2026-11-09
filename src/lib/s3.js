// Minimal S3 client (SigV4, path-style) for onpod buckets — no dependencies.
// Env (auto-injected by `onpod app deploy --attach-bucket`):
//   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_ENDPOINT_URL_S3, S3_BUCKET
import crypto from 'node:crypto';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export class S3Store {
  constructor({ endpoint, bucket, accessKeyId, secretAccessKey, region = 'auto', fetchImpl = globalThis.fetch }) {
    this.endpoint = new URL(endpoint.replace(/\/$/, ''));
    this.bucket = bucket; this.accessKeyId = accessKeyId; this.secretAccessKey = secretAccessKey;
    this.region = region || 'auto'; this.fetch = fetchImpl;
  }

  static fromEnv(env = process.env) {
    const { AWS_ACCESS_KEY_ID: a, AWS_SECRET_ACCESS_KEY: s, AWS_ENDPOINT_URL_S3: e, S3_BUCKET: b, AWS_REGION: r } = env;
    return a && s && e && b ? new S3Store({ endpoint: e, bucket: b, accessKeyId: a, secretAccessKey: s, region: r }) : null;
  }

  // Returns { url, headers } signed with AWS Signature V4 (path-style).
  sign(method, key, body = '', now = new Date()) {
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const basePath = this.endpoint.pathname.replace(/\/$/, '');
    const path = `${basePath}/${enc(this.bucket)}/${key.split('/').map(enc).join('/')}`;
    const payloadHash = sha256(body);
    const host = this.endpoint.host;
    const auth = signV4({ method, host, path, query: '', payloadHash, amzDate, region: this.region,
      accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey });
    return {
      url: `${this.endpoint.protocol}//${host}${path}`,
      headers: { 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, Authorization: auth },
    };
  }

  async get(key) {
    const { url, headers } = this.sign('GET', key);
    const res = await this.fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(15000) });
    if (res.status === 404) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`S3 GET ${key} → ${res.status} ${text.slice(0, 150)}`);
    return text;
  }

  async put(key, body, contentType = 'application/json') {
    const { url, headers } = this.sign('PUT', key, body);
    const res = await this.fetch(url, { method: 'PUT', headers: { ...headers, 'content-type': contentType }, body, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`S3 PUT ${key} → ${res.status} ${(await res.text()).slice(0, 150)}`);
  }
}

// AWS SigV4 for S3 with the 3 signed headers host;x-amz-content-sha256;x-amz-date.
export function signV4({ method, host, path, query, payloadHash, amzDate, region, accessKeyId, secretAccessKey }) {
  const day = amzDate.slice(0, 8);
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, day), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}
