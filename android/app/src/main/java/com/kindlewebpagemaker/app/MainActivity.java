package com.kindlewebpagemaker.app;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        handleSendIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleSendIntent(intent);
    }

    private void handleSendIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        String type = intent.getType();

        if (Intent.ACTION_SEND.equals(action) && type != null) {
            if ("text/plain".equals(type)) {
                String sharedText = intent.getStringExtra(Intent.EXTRA_TEXT);
                if (sharedText != null && !sharedText.trim().isEmpty()) {
                    dispatchSharedUrl(sharedText.trim());
                }
            }
        }
    }

    private void dispatchSharedUrl(final String url) {
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().post(new Runnable() {
                @Override
                public void run() {
                    String escaped = url.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ");
                    String js = "window.__INITIAL_SHARED_URL__ = '" + escaped + "';"
                              + "window.dispatchEvent(new CustomEvent('incomingSharedUrl', { detail: '" + escaped + "' }));"
                              + "if (window.handleIncomingShare) { window.handleIncomingShare('" + escaped + "'); }";
                    getBridge().getWebView().evaluateJavascript(js, null);
                }
            });
        }
    }
}
