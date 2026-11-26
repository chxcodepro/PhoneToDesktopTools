package server

import (
	"context"
	"testing"
	"time"
)

func TestTilesFlowControl(t *testing.T) {
	s := &Session{}
	s.stream.ackCh = make(chan struct{}, 1)
	ctx := context.Background()

	// 没有未确认的帧：立即返回
	if !s.waitAcked(ctx) {
		t.Fatal("应立即返回 true")
	}
	// 发了 2 帧都没确认：要等，确认第 1 帧后放行
	s.stream.seq.Store(2)
	done := make(chan bool)
	go func() { done <- s.waitAcked(ctx) }()
	select {
	case <-done:
		t.Fatal("2 帧没确认时不应放行")
	case <-time.After(100 * time.Millisecond):
	}
	s.ackFrame(1)
	select {
	case ok := <-done:
		if !ok {
			t.Fatal("确认后应返回 true")
		}
	case <-time.After(time.Second):
		t.Fatal("确认后没有放行")
	}
	// 旧的确认不会把编号往回拨
	s.ackFrame(0)
	if s.stream.acked.Load() != 1 {
		t.Fatalf("acked = %d，期望 1", s.stream.acked.Load())
	}
	// 推流停止时返回 false
	s.stream.seq.Store(5)
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if s.waitAcked(cctx) {
		t.Fatal("推流已停止应返回 false")
	}
}
