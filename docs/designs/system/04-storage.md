# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## ストレージ抽象化

### 1. 目的

ローカルとクラウドで同一の Ingestion / Report コードを動かすため、`ObjectStorage` インターフェースを定義する。実装は環境変数で切り替える。

```typescript
// packages/storage/src/object-storage.ts
export interface ObjectStorage {
  put(uri: string, body: Buffer | NodeJS.ReadableStream, opts?: PutOptions): Promise<{ uri: string; etag?: string }>;
  get(uri: string): Promise<NodeJS.ReadableStream>;
  getText(uri: string): Promise<string>;
  exists(uri: string): Promise<boolean>;
  signedUrl?(uri: string, ttlSeconds: number): Promise<string>;
  list(prefix: string): AsyncIterable<{ uri: string; size: number; updatedAt: Date }>;
}

export interface PutOptions {
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
}
```

### 2. 実装

| 環境 | 実装 | URI スキーム | 設定 |
|---|---|---|---|
| ローカル開発 / オンプレ Docker | `LocalFsObjectStorage` | `file://` | `STORAGE_ROOT=/data` を Docker volume にマウント |
| GCP デプロイ | `GcsObjectStorage` | `gs://` | `STORAGE_BUCKET=pufu-lens-prod` |
| 将来: S3 / Azure | `S3ObjectStorage` 等 | `s3://` / `az://` | 各 SDK で実装 |

`StorageFactory.fromEnv()` が `STORAGE_DRIVER`（`local` / `gcs` / …）と `STORAGE_ROOT` / `STORAGE_BUCKET` を読んで適切な実装を返す。Ingestion・Report・Chat いずれも同じ抽象を使う。

### 3. ローカルデプロイ運用

- `docker-compose.yml` に `pufu-lens-data` という volume を定義し、Mastra Server / Ingestion Job コンテナへ `/data` にマウントする。
- バックアップは `tar` または `rclone` で `pufu-lens-data` を外部ストレージへ同期する。

### 4. クラウドデプロイ運用

- GCS バケット `pufu-lens-prod` を 1 個作成し、プロジェクトごとにプレフィックスで分ける。
- バケットは Private のままにし、Web からの直接ダウンロードは Next.js 経由（権限チェック + signed URL）に限定する。
- Lifecycle で 30 日超の `raw/web/...` を Nearline、180 日超を Coldline に降格させてコスト最適化する。
---
