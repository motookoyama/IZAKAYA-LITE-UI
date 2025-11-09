## IZAKAYA Playability Monitor

日次で Playwright を使ったダミーユーザー検証を実行し、LLM チャットが稼働している証拠を自動取得するための手順です。

### 1. コンテナビルド

```bash
PROJECT_ID=gen-lang-client-0676058874
REGION=asia-northeast1
IMAGE="asia-northeast1-docker.pkg.dev/${PROJECT_ID}/izakaya/playability-job:latest"

gcloud builds submit \
  --project "${PROJECT_ID}" \
  --tag "${IMAGE}" \
  -f ops/playability-job/Dockerfile .
```

### 2. Cloud Run Job 作成 / 更新

```bash
JOB_NAME=izakaya-playability-job
SERVICE_ACCOUNT="${PROJECT_ID}@appspot.gserviceaccount.com"
FE_URL="https://izakaya-lite-ui-95139013565.asia-northeast1.run.app"
BFF_BASE_URL="https://izakaya-bff-95139013565.asia-northeast1.run.app"
TEST_USER_ID="playability-bot"

gcloud run jobs create "${JOB_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --image "${IMAGE}" \
  --service-account "${SERVICE_ACCOUNT}" \
  --set-env-vars "FE_URL=${FE_URL},BFF_BASE_URL=${BFF_BASE_URL},TEST_USER_ID=${TEST_USER_ID},LLM_ASSISTED_CHAT_MESSAGE=テスト：稼働確認,EXPECTED_POINTS_CHANGE=0" \
  --cpu=1 \
  --memory=1Gi \
  --timeout=300s \
  --max-retries=1 \
  --execute-nowait

gcloud run jobs update "${JOB_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --image "${IMAGE}" \
  --set-env-vars "FE_URL=${FE_URL},BFF_BASE_URL=${BFF_BASE_URL},TEST_USER_ID=${TEST_USER_ID},LLM_ASSISTED_CHAT_MESSAGE=テスト：稼働確認,EXPECTED_POINTS_CHANGE=0"
```

### 3. Cloud Scheduler で毎日実行

```bash
SCHEDULER_NAME=izakaya-playability-scheduler
CRON="0 18 * * *"  # JST 03:00

gcloud scheduler jobs create http "${SCHEDULER_NAME}" \
  --project "${PROJECT_ID}" \
  --location "${REGION}" \
  --schedule "${CRON}" \
  --uri "https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_NAME}:run" \
  --http-method POST \
  --oauth-service-account-email "${SERVICE_ACCOUNT}" \
  --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform"
```

### 4. ログ確認

Cloud Logging クエリ:

```
resource.type="cloud_run_job"
jsonPayload.event="daily_test_user"
```

成功例:

```json
{
  "event": "daily_test_user",
  "status": "success",
  "prompt": "テスト：稼働確認",
  "reply": "お待たせしました……",
  "balance_before": 100,
  "balance_after": 100,
  "delta": 0,
  "expected_delta": 0,
  "response_time_ms": 4289,
  "timestamp": "2025-11-08T12:00:00Z"
}
```

失敗時は `status:"failure"` と `error` が記録され、スクリーンショットパス（Playwright）も JSON に含まれます。
