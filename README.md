# Pufu Lens

Pufu Lens は、プロジェクトに関連する Gmail、Google Drive、GitHub、Web ページのデータを収集し、PostgreSQL 上のナレッジグラフとベクトル検索に展開するためのモノレポです。管理 UI、データ取り込みワークフロー、チャット、レポート生成を含みます。

## コンセプト

Pufu Lens は、散らばったプロジェクトの記憶を集め、あとから自然言語で見通せるレンズにするためのシステムです。

メール、Drive 文書、GitHub Issue、Web ページなどに分散した情報を継続的に取り込み、原本を保存しながら、AI が参照しやすい知識基盤へ変換します。人が過去の経緯や意思決定を掘り起こす代わりに、Pufu Lens がプロジェクトの断片を横断して整理し、チャットやレポートを通じて現在の状況、背景、リスク、次のアクションを把握しやすくします。

## 主な機能

- 複数プロジェクトのデータソース、取り込みデータ、レポートの分離管理
- Gmail、Drive、GitHub、Web ページからのデータ収集と原本保存
- Apache AGE、pgvector、オブジェクトストレージを組み合わせた知識基盤
- Mastra Agent と Gemini によるチャット、分析、レポート生成
- Next.js による管理画面、プロジェクト画面、公開レポート画面

## 技術スタック

- Monorepo: pnpm workspaces / Turborepo
- Frontend: Next.js、AI SDK、Auth.js
- Agent: Mastra
- LLM / Embedding: Gemini API
- Database: PostgreSQL、Apache AGE、pgvector
- Storage: ローカルファイルシステム / Google Cloud Storage
- Deployment: Cloud Run、Cloud Run Jobs、Firebase App Hosting、GCE VM

## ディレクトリ構成

- `apps/web`: Next.js フロントエンド
- `apps/mastra`: Mastra Server と Agent / Workflow
- `packages/storage`: オブジェクトストレージ抽象化
- `packages/ingestion`: データ取り込み処理
- `packages/project-tenancy`: プロジェクト単位のテナンシー関連処理
- `infra`: DB、Docker、scheduler などのインフラ定義
- `scripts`: 開発、運用、取り込み、DB 管理用スクリプト
- `docs`: 設計書、計画、運用ドキュメント

## 開発

### 前提条件

ローカル実行には以下が必要です。

- pnpm 11.1.1
- PostgreSQL 18
- Apache AGE および pgvector 拡張
- Gemini API キー
- 必要な環境変数。各アプリやスクリプトの `.env.example` を参考に設定してください。

### セットアップ

依存関係をインストールします。

```sh
pnpm install
```

Web アプリを起動します。root の `pnpm dev` は `apps/web` の開発サーバーを起動します。

```sh
pnpm dev
```

Mastra サーバーを起動する場合は、別プロセスで以下を実行します。

```sh
pnpm --filter @pufu-lens/mastra dev
```

主要な検証コマンドです。

```sh
pnpm lint
pnpm typecheck
pnpm test
```

## ドキュメント

詳細な設計は `docs/designs/` を参照してください。作業計画は `docs/plans/`、現在の plan 状態は `docs/plans/plan-status.md` で管理します。

## ライセンス

このリポジトリは Elastic License 2.0 の下で提供されます。詳細は `LICENSE` を参照してください。
