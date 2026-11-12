'use client';

import { useEffect, useRef, useState } from 'react';

/** 浏览器自带的文件控件按系统语言显示文字，这里换成固定英文的按钮。放在 <label> 里用，点整行都能选文件。 */
export function FileInput(props: { name: string; accept: string; multiple?: boolean; required?: boolean }) {
  const [names, setNames] = useState<string[]>([]);
  const ref = useRef<HTMLInputElement>(null);
  // 表单 reset() 会清空文件但不触发 change，跟着把显示的文件名清掉。
  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const clear = () => setNames([]);
    form.addEventListener('reset', clear);
    return () => form.removeEventListener('reset', clear);
  }, []);
  return (
    <span className="file-pick">
      <input
        ref={ref}
        type="file"
        className="file-native"
        {...props}
        onChange={(e) => setNames(Array.from(e.target.files ?? []).map((f) => f.name))}
      />
      <span className="btn">{props.multiple ? 'Choose files' : 'Choose file'}</span>
      <span className="muted small">{names.length === 0 ? 'No file chosen' : names.length === 1 ? names[0] : `${names.length} files`}</span>
    </span>
  );
}
