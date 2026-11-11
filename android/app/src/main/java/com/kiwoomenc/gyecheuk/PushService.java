package com.kiwoomenc.gyecheuk;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

// 서버가 보낸 푸시(제목·문구·종류·날짜)를 받아 회사 앱다운 알림으로 띄운다. 앱이 꺼져 있어도 이 서비스가 깨어나 처리한다.
// 모양: 머리줄 "키움이엔씨 · 현장 계측", 회사 로고(큰 아이콘), 종류별 색(메모·이상보고 = 빨강, 그 밖 = 회사 파랑),
// 긴 문구는 펼쳐 보기, 같은 종류는 한 묶음. 누르면 앱이 열리면서 그 날짜 창으로 간다(MainActivity EXTRA_OPEN).
public class PushService extends FirebaseMessagingService {

    static final String PREFS = "push";
    static final String KEY_TOKEN = "token";
    static final String EXTRA_OPEN = "push_open";   // {"kind":"memo","date":"2026-11-12"}

    private static final int BRAND_BLUE = Color.parseColor("#2B6FB3");
    private static final int ALERT_RED = Color.parseColor("#E5484D");
    private static final String SUB_TEXT = "현장 계측";

    // 종류 → 알림 채널(휴대폰 설정에서 종류별로 소리·진동을 따로 고를 수 있다)
    private static final String CH_MEMO = "kieum_memo";
    private static final String CH_SCHEDULE = "kieum_schedule";
    private static final String CH_INPUT = "input_alerts";   // 예전 채널 이름 그대로(이미 켠 설정 유지)

    @Override
    public void onNewToken(String token) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_TOKEN, token).apply();
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        Map<String, String> data = message.getData();
        String title = data.get("title");
        String body = data.get("body");
        if (title == null || body == null) return;
        show(this, title, body, value(data, "kind"), value(data, "date"));
    }

    private static String value(Map<String, String> data, String key) {
        String v = data.get(key);
        return v == null ? "" : v;
    }

    private static void ensureChannels(NotificationManager nm) {
        NotificationChannel memo = new NotificationChannel(CH_MEMO, "상황 메모·이상보고", NotificationManager.IMPORTANCE_HIGH);
        memo.setDescription("누가 상황 메모나 이상보고를 남기면 바로 알려 줍니다");
        memo.enableLights(true);
        memo.setLightColor(ALERT_RED);
        memo.enableVibration(true);
        memo.setVibrationPattern(new long[]{0, 220, 120, 220});
        NotificationChannel schedule = new NotificationChannel(CH_SCHEDULE, "일정", NotificationManager.IMPORTANCE_HIGH);
        schedule.setDescription("일정이 새로 들어오거나 바뀌면 알려 줍니다");
        schedule.enableLights(true);
        schedule.setLightColor(BRAND_BLUE);
        NotificationChannel input = new NotificationChannel(CH_INPUT, "계측 입력·사진·명함", NotificationManager.IMPORTANCE_DEFAULT);
        input.setDescription("다른 직원의 계측값·사진·측량파일·명함 저장");
        nm.createNotificationChannel(memo);
        nm.createNotificationChannel(schedule);
        nm.createNotificationChannel(input);
    }

    static void show(Context ctx, String title, String body, String kind, String date) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        ensureChannels(nm);
        boolean alert = "memo".equals(kind) || "issue".equals(kind);
        String channel = alert ? CH_MEMO : "schedule".equals(kind) ? CH_SCHEDULE : CH_INPUT;
        int color = alert ? ALERT_RED : BRAND_BLUE;
        String group = "kieum_" + (kind.isEmpty() ? "input" : kind);
        int id = (int) (System.currentTimeMillis() & 0x7fffffff);   // 번호가 달라야 알림이 서로 덮어쓰지 않고 쌓인다

        String open = "{\"kind\":\"" + kind.replaceAll("[^a-z]", "") + "\",\"date\":\"" + date.replaceAll("[^0-9-]", "") + "\"}";
        Intent intent = new Intent(ctx, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_OPEN, open);
        PendingIntent tap = PendingIntent.getActivity(ctx, id, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Bitmap logo = BitmapFactory.decodeResource(ctx.getResources(), R.mipmap.ic_launcher);
        Notification.Builder b = new Notification.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_stat_alert)
            .setLargeIcon(logo)
            .setColor(color)
            .setSubText(SUB_TEXT)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().setBigContentTitle(title).bigText(body))
            .setCategory(alert ? Notification.CATEGORY_MESSAGE : "schedule".equals(kind) ? Notification.CATEGORY_EVENT : Notification.CATEGORY_STATUS)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis())
            .setGroup(group)
            .setContentIntent(tap)
            .setAutoCancel(true);
        nm.notify(id, b.build());

        // 같은 종류가 여러 건 쌓이면 한 묶음으로 접힌다(1건일 때는 안드로이드가 묶음을 숨긴다)
        Notification summary = new Notification.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_stat_alert)
            .setColor(color)
            .setSubText(alert ? "상황 메모·이상보고" : "schedule".equals(kind) ? "일정" : SUB_TEXT)
            .setStyle(new Notification.InboxStyle().setSummaryText("키움이엔씨"))
            .setGroup(group)
            .setGroupSummary(true)
            .setAutoCancel(true)
            .build();
        nm.notify(group.hashCode(), summary);
    }
}
