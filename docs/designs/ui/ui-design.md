---
name: Pufu Lens デザインシステム
colors:
  surface: '#0b1326'
  surface-dim: '#0b1326'
  surface-bright: '#31394d'
  surface-container-lowest: '#060e20'
  surface-container-low: '#131b2e'
  surface-container: '#171f33'
  surface-container-high: '#222a3d'
  surface-container-highest: '#2d3449'
  on-surface: '#dae2fd'
  on-surface-variant: '#c2c6d8'
  inverse-surface: '#dae2fd'
  inverse-on-surface: '#283044'
  outline: '#8c90a1'
  outline-variant: '#424656'
  surface-tint: '#b3c5ff'
  primary: '#b3c5ff'
  on-primary: '#002b75'
  primary-container: '#0066ff'
  on-primary-container: '#f8f7ff'
  inverse-primary: '#0054d6'
  secondary: '#d8b9ff'
  on-secondary: '#450086'
  secondary-container: '#6e06d0'
  on-secondary-container: '#d5b5ff'
  tertiary: '#4edea3'
  on-tertiary: '#003824'
  tertiary-container: '#008259'
  on-tertiary-container: '#e1ffec'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#dae1ff'
  primary-fixed-dim: '#b3c5ff'
  on-primary-fixed: '#001849'
  on-primary-fixed-variant: '#003fa4'
  secondary-fixed: '#eddcff'
  secondary-fixed-dim: '#d8b9ff'
  on-secondary-fixed: '#290055'
  on-secondary-fixed-variant: '#6200bc'
  tertiary-fixed: '#6ffbbe'
  tertiary-fixed-dim: '#4edea3'
  on-tertiary-fixed: '#002113'
  on-tertiary-fixed-variant: '#005236'
  background: '#0b1326'
  on-background: '#dae2fd'
  surface-variant: '#2d3449'
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  headline-sm:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-md:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
    letterSpacing: 0.02em
  label-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.05em
  headline-lg-mobile:
    fontFamily: Inter
    fontSize: 28px
    fontWeight: '600'
    lineHeight: 36px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
  3xl: 64px
  gutter: 24px
  margin-mobile: 16px
  margin-desktop: 32px
---

## ブランドとスタイル

このデザインシステムは **Enterprise Modern** の美学を土台とし、複雑なプロジェクト階層やナレッジグラフを扱う、高い認知負荷の環境に合わせて設計されています。高機能な業務ソフトウェアと最先端の人工知能の間をつなぐことを目指します。

ビジュアルの中心にあるコンセプトは **「構造化された知性」** です。洗練された「ダークモードファースト」のアプローチを採用しつつ、ライトテーマにも対応できる設計とします。過剰な色使いではなく、トーンの重なりによって奥行きを表現します。ユーザーが受け取る印象は、落ち着いた制御感、精度、知的な明快さであるべきです。

**主要なスタイルの柱:**

- **洗練されたミニマリズム:** データ可視化において、すべてのピクセルが機能的な目的を持つこと。
- **選択的なグラスモーフィズム:** モーダルやドロップダウンなどの一時的なレイヤー、および AI サイドパネルに限定して使用し、異なる「知性の平面」を示すこと。
- **運動感のあるフィードバック:** エージェントの信頼性を補強するため、素早く「機械的」に感じられるマイクロインタラクションを用いること。

## カラー

パレットは、高コントラストでプロフェッショナルなトーンを軸に構成します。

- **Primary（Intelligence Blue）:** `#0066FF`。主要なコールトゥアクション、アクティブな選択状態、フォーカスインジケーターに限定して使用します。
- **Secondary（Agent Amethyst）:** `#9D50FF`。AI 生成コンテンツ、エージェントの状態、機械学習に関する操作に特化して使用します。
- **Tertiary（Status Emerald）:** `#10B981`。成功状態、「アクティブ」なプロジェクト状態、正常なデータ同期に使用します。
- **Neutrals（Navy/Charcoal）:** 基本スケールでは、背景に Deep Navy（`#020617`）系を、コンテナに Slate/Charcoal 系を使用します。

テーマは dark を既定とし、ユーザーが明示的に light / dark を切り替えた場合は選択を cookie に保存して初回描画から反映します。ライトテーマは白一色ではなく、業務 UI 向けの低彩度な明色面を使い、同じ意味の CSS トークンを維持します。

**Light theme tokens:**

- **Background:** `#F6F8FC`
- **Surface:** `#FFFFFF`
- **Surface 2:** `#EEF2F7`
- **Line:** `#CFD7E6`
- **Text:** `#111827`
- **Muted:** `#526070`
- **Primary Blue:** `#005BD8`
- **Strong Blue:** `#0066FF`
- **Agent Amethyst:** `#7C3AED`
- **Status Emerald:** `#047857`
- **Warning Amber:** `#B45309`
- **Error Red:** `#DC2626`

**機能別のカラー適用:**

- AI が「思考中」である状態を示す場合のみ、**Amethyst** のグラデーションを控えめに使用します。
- **エラー状態** には、洗練されたネイビー基調と衝突しないよう、落ち着いた Crimson（`#EF4444`）を使用します。

## タイポグラフィ

このデザインシステムでは、データ密度の高い環境でも優れた可読性を発揮する **Inter** を、主要なインターフェイス要素すべてに使用します。技術的なメタデータ、コードスニペット、システムログには **JetBrains Mono** を導入し、「人間のコンテンツ」と「システムロジック」を視覚的に明確に区別します。

**階層ルール:**

- **見出し:** 大きなサイズでは字間をやや詰め、コンパクトで上質な印象を維持します。
- **本文:** 通常の読み物には標準ウェイト（400）を使い、段落内の強調には Medium（500）を使用します。
- **ラベル:** ステータスバッジや小さな UI インジケーターで JetBrains Mono を使う場合は、視認性を最大化するため常に大文字にします。

## レイアウトとスペーシング

レイアウトでは、メインコンテンツ領域に **12 カラムのフルードグリッド** を使用します。左ナビゲーションは固定幅（280px）、右側の AI サイドパネルは可変幅（360px - 480px）とします。

画面単位の領域構成、ナビゲーション、レスポンシブ挙動は [UI レイアウト設計](ui-layout.md) に従います。

**スペーシングの考え方:**

- 厳密な **4px ベースライングリッド** に従います。
- **内部余白:** 標準的なカードの余白には `md`（16px）を、主要なセクションコンテナには `lg`（24px）を使用します。
- **情報密度:** データテーブルやファイルツリーでは、縦方向の余白を `sm`（8px）まで縮小した「Compact」モードを使用します。
- **レスポンシブ挙動:** モバイルではマージンを `16px` に縮小し、サイドパネルはフルスクリーンのオーバーレイに変化します。

## エレベーションと奥行き

階層は **トーンの重なり** と **控えめなシャドウ** によって表現します。

1.  **Level 0（背景）:** `#020617` - キャンバス。
2.  **Level 1（デフォルトサーフェス）:** `#0F172A` - メインサイドバーとフッターに使用します。
3.  **Level 2（カード/コンテナ）:** `#1E293B` - 標準的なコンテンツブロック。`#334155` の 1px ボーダーを含みます。
4.  **Level 3（ポップオーバー/モーダル）:** `#1E293B` に `backdrop-filter: blur(12px)` と不透明度 20% の白いボーダーを組み合わせます。

**シャドウ:**
「Ambient Deep」シャドウを使用します。単一の柔らかいシャドウは `0 4px 20px -2px rgba(0, 0, 0, 0.5)` とします。重い黒のシャドウは避け、背景色のより暗い色調を使うことで「Navy」の印象を維持します。

## 形状

形状の言語は **「Soft Professional」** です。

- **コンポーネント:** 標準ボタン、入力フィールド、小さなカードには `rounded`（4px / 0.25rem）を使用します。
- **主要コンテナ:** プロジェクトボードやメインワークスペースのコンテナには `rounded-lg`（8px / 0.5rem）を使用します。
- **ステータスピル:** ステータスインジケーターやバッジは完全な角丸（ピル形状）にし、インタラクティブなボタンと区別します。
- **データ可視化:** ナレッジグラフのノードは円形にし、エッジは柔らかなカーブを持つ 1.5px の線とします。
- **Graph の詳細表示:** 通常表示では選択したノードまたはエッジの Details を既存の詳細パネルに表示します。Document ノード選択時は、その document の chunk を遅延取得し、Details 下部に document chunk の一覧を表示します。一覧行を選択すると同じ領域で chunk 詳細へ切り替えます。Graph を最大化している場合に限り、選択時に同じ Details を Graph 内の非ブロッキングなフローティングダイアログで表示し、Document ノードでは通常表示と同じ chunk 一覧 / chunk 詳細切り替えを提供します。ダイアログはヘッダーをドラッグして移動でき、表示中も Graph のパン・ズーム・選択操作は継続できます。最大化を解除したときはフローティングダイアログを閉じます。フォールバック最大化中は Escape キーで先にフローティングダイアログを閉じ、再度 Escape で最大化を解除します。

## コンポーネント

### ボタンと入力

- **主要アクション:** 単色の Intelligence Blue（`#0066FF`）に白いテキストを組み合わせます。
- **AI アクション:** `#9D50FF` から `#6366F1` へのグラデーション背景を使用します。
- **入力:** Dark Slate の背景（`#0F172A`）に 1px ボーダーを組み合わせます。フォーカス時はボーダーを Blue に遷移させ、2px の外側グローを表示します。

### ステータスバッジ

- **Active:** Emerald の背景（不透明度 10%）に Emerald のテキストを組み合わせます。
- **Syncing:** Amethyst の背景（不透明度 10%）に、控えめなパルスアニメーションを組み合わせます。
- **Failed:** Red の背景（不透明度 10%）に Red のテキストを組み合わせます。

### AI チャットとシステムレポート

- **AI チャットバブル:** 控えめなグラスモーフィズム効果と、細い Amethyst の左ボーダーでスタイルを設定します。タイポグラフィには Inter を使用します。
- **チャットスレッド:** 複数回のラリーを前提に、ユーザー発言と AI 回答を時系列で残します。AI 回答は Markdown として表示し、直下には回答ごとに参照した document / public source を compact な 1 カラムリストで表示します。tool call は折りたたみ可能な補助情報として扱います。
- **プライベートチャット履歴:** 画面を開いた直後のスレッドは空にし、保存済みの過去 turn はコンパクトな履歴一覧として表示します。履歴を選択した場合のみ、その turn の質問と回答を参照表示します。
- **編集 metadata:** 要約、論点整理、リスク抽出などの編集方針は UI で選ばせず、対話内容から自動判定します。表示する場合は AI 回答直下の compact な折りたたみ補助情報にし、根拠 source や本文より目立たせません。
- **システムレポート:** `Level 2` のカードサーフェスを使って構造化し、ヘッダーには等幅フォント（JetBrains Mono）を使用します。データポイントを区切るため、区切り線を多めに使用します。

### インタラクティブなデータソース

- Data Source 詳細の Settings では、GitHub / Drive / Gmail に自動同期の ON / OFF、`Asia/Tokyo` の日次時刻、次回実行、前回成功・失敗を表示する。Web は自動実行対象外であることと手動 Collect & Ingest の導線を表示する。

- **状態:**
  - _Default:_ 控えめなボーダーと低コントラストのアイコン。
  - _Hover:_ サーフェスカラーを 5% 明るくし、ボーダーも明るくします。
  - _Selected:_ 2px の Primary Blue ボーダーと、小さなチェックマーク付きのコーナーリボン。
