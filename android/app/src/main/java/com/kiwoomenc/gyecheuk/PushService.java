package com.kiwoomenc.gyecheuk;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

// 서버가 보낸 푸시(제목·문구)를 받아 알림으로 띄운다. 앱이 꺼져 있어도 이 서비스가 깨어나 처리한다.
public class PushService extends FirebaseMessagingService {

    static final String PREFS = "push";
    static final String KEY_TOKEN = "token";
    private static final String CHANNEL_ID = "input_alerts";

    // 토큰이 새로 만들어지면 폰에 저장해 둔다. 앱 화면이 열릴 때 AndroidPush.getToken()으로 읽어 서버에 등록한다.
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
        show(this, title, body);
    }

    private static void show(Context ctx, String title, String body) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "입력 알림", NotificationManager.IMPORTANCE_HIGH));
        Intent open = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_alert)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .build();
        nm.notify((int) (System.currentTimeMillis() & 0x7fffffff), n);   // 번호가 달라야 알림이 서로 덮어쓰지 않고 쌓인다
    }
}
