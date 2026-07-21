export interface SubscribeButtonProps {
  hostStreaming: boolean;
  isHost: boolean;
  subscribed: boolean;
  onSubscribe: () => void;
  onUnsubscribe: () => void;
}

export function SubscribeButton({
  hostStreaming,
  isHost,
  subscribed,
  onSubscribe,
  onUnsubscribe,
}: SubscribeButtonProps) {
  if (isHost || !hostStreaming) return null;

  return (
    <button
      type="button"
      onClick={subscribed ? onUnsubscribe : onSubscribe}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
        subscribed
          ? 'border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700'
          : 'bg-indigo-600 text-white hover:bg-indigo-500'
      }`}
    >
      {subscribed ? 'Отписаться от стрима' : 'Смотреть стрим'}
    </button>
  );
}
