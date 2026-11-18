<?php
/**
 * BotNest: يخلّي سكربت PHP مكتوب على طريقة الـ webhook يشتغل من غير ما يتعدّل.
 * المنصة بتسحب التحديثات من تلجرم، وتشغّل السكربت مرة لكل تحديث، وهنا بنحط التحديث في php://input
 * ونظبط $_SERVER كأن الطلب جاي من تلجرم.
 */
(function () {
    $file = getenv('VEX_UPDATE_FILE');
    $body = ($file && is_readable($file)) ? (string) file_get_contents($file) : '';

    $_SERVER['REQUEST_METHOD']  = 'POST';
    $_SERVER['CONTENT_TYPE']    = 'application/json';
    $_SERVER['CONTENT_LENGTH']  = strlen($body);
    $_SERVER['REQUEST_URI']     = '/';
    $_SERVER['HTTP_HOST']       = 'localhost';
    $_SERVER['REMOTE_ADDR']     = '149.154.167.220';
    $_SERVER['HTTP_CONTENT_TYPE'] = 'application/json';

    final class BotNestPhpStream
    {
        public $context;
        private static $body = '';
        private $handle = null;
        private $pos = 0;

        public static function setBody(string $b): void { self::$body = $b; }

        public function stream_open($path, $mode, $options, &$opened)
        {
            if (strtolower($path) === 'php://input') {
                return true;
            }
            // أي مسار php:// تاني (stdout, memory, temp...) نسيبه للأصلي
            stream_wrapper_restore('php');
            $h = @fopen($path, $mode);
            stream_wrapper_unregister('php');
            stream_wrapper_register('php', self::class);
            if ($h === false) {
                return false;
            }
            $this->handle = $h;
            return true;
        }

        public function stream_read($n)
        {
            if ($this->handle) {
                return fread($this->handle, $n);
            }
            $r = substr(self::$body, $this->pos, $n);
            $this->pos += strlen($r);
            return $r;
        }

        public function stream_write($d) { return $this->handle ? fwrite($this->handle, $d) : 0; }
        public function stream_eof() { return $this->handle ? feof($this->handle) : $this->pos >= strlen(self::$body); }
        public function stream_stat() { return $this->handle ? fstat($this->handle) : ['size' => strlen(self::$body)]; }
        public function stream_flush() { return $this->handle ? fflush($this->handle) : true; }
        public function stream_close() { if ($this->handle) { fclose($this->handle); } }
        public function stream_seek($offset, $whence)
        {
            if ($this->handle) { return fseek($this->handle, $offset, $whence) === 0; }
            if ($whence === SEEK_SET) { $this->pos = $offset; return true; }
            return false;
        }
        public function stream_tell() { return $this->handle ? ftell($this->handle) : $this->pos; }
        public function stream_set_option($option, $arg1, $arg2) { return false; }
    }

    BotNestPhpStream::setBody($body);
    stream_wrapper_unregister('php');
    stream_wrapper_register('php', BotNestPhpStream::class);
})();
