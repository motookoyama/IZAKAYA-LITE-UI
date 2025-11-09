#!/bin/bash

# ========= 設定 =========
UI_URL="https://izakaya-lite-ui-95139013565.asia-northeast1.run.app"
BFF_URL="https://izakaya-bff-95139013565.asia-northeast1.run.app"
# UIがBFFと通信できるAPI（※UI内でBFFを叩く部分に合わせて修正可）
CHECK_API="$UI_URL/chat/health"

UI_SERVICE="izakaya-lite-ui"
BFF_SERVICE="izakaya-verse-promo"
REGION="asia-northeast1"
PROJECT="gen-lang-client-0676058874"

LOGFILE="./izakaya_monitor.log"
echo "===== $(date) : Monitoring Start =====" | tee -a $LOGFILE

# ========= 共通関数 =========
check_200() {
    URL=$1
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$URL")
    echo "$STATUS"
}

restart_service() {
    NAME=$1
    echo "⚠️  $NAME を再起動します..." | tee -a $LOGFILE
    gcloud run services update $NAME \
        --region=$REGION \
        --project=$PROJECT \
        --quiet
    echo "✅ 再起動完了：$NAME" | tee -a $LOGFILE
}

# ========= 1) UIヘルスチェック =========
UI_STATUS=$(check_200 $UI_URL)
if [ "$UI_STATUS" != "200" ]; then
    echo "❌ UIダウン ($UI_STATUS) → 再起動" | tee -a $LOGFILE
    restart_service $UI_SERVICE
else
    echo "✅ UI OK ($UI_STATUS)" | tee -a $LOGFILE
fi

# ========= 2) BFFヘルスチェック =========
BFF_STATUS=$(check_200 $BFF_URL)
if [ "$BFF_STATUS" != "200" ]; then
    echo "❌ BFFダウン ($BFF_STATUS) → 再起動" | tee -a $LOGFILE
    restart_service $BFF_SERVICE
else
    echo "✅ BFF OK ($BFF_STATUS)" | tee -a $LOGFILE
fi

# ========= 3) UI → BFF の通信確認 =========
API_STATUS=$(check_200 $CHECK_API)
if [ "$API_STATUS" != "200" ]; then
    echo "❌ UI→BFF 通信NG ($API_STATUS) → 両方チェック" | tee -a $LOGFILE
    restart_service $UI_SERVICE
    restart_service $BFF_SERVICE
else
    echo "✅ UI→BFF 通信OK ($API_STATUS)" | tee -a $LOGFILE
fi

echo "===== $(date) : Monitoring End =====" | tee -a $LOGFILE
