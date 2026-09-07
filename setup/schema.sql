-- ============================================
-- Supabase Database Schema
-- 1C Бухгалтерия - Облачная система учета
-- ============================================
-- Выполните этот SQL в Supabase Dashboard -> SQL Editor
-- ============================================

-- Таблица основных данных (одна запись на пользователя)
CREATE TABLE IF NOT EXISTS app_data (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE NOT NULL,
    data JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Таблица резервных копий
CREATE TABLE IF NOT EXISTS backups (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    data JSONB NOT NULL DEFAULT '{}',
    note TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Индексы
CREATE INDEX IF NOT EXISTS idx_app_data_user_id ON app_data(user_id);
CREATE INDEX IF NOT EXISTS idx_backups_user_id ON backups(user_id);
CREATE INDEX IF NOT EXISTS idx_backups_created_at ON backups(created_at DESC);

-- ============================================
-- Row Level Security (RLS)
-- Каждый пользователь видит только свои данные
-- ============================================

ALTER TABLE app_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE backups ENABLE ROW LEVEL SECURITY;

-- Политики для app_data
CREATE POLICY "Users can view own data"
    ON app_data FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own data"
    ON app_data FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own data"
    ON app_data FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own data"
    ON app_data FOR DELETE
    USING (auth.uid() = user_id);

-- Политики для backups
CREATE POLICY "Users can view own backups"
    ON backups FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can create own backups"
    ON backups FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own backups"
    ON backups FOR DELETE
    USING (auth.uid() = user_id);

-- ============================================
-- Автоматическое обновление updated_at
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER app_data_updated_at
    BEFORE UPDATE ON app_data
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- ============================================
-- Включение Realtime для синхронизации
-- между устройствами
-- ============================================

ALTER PUBLICATION supabase_realtime ADD TABLE app_data;

-- ============================================
-- Ограничение количества бэкапов (макс 50 на пользователя)
-- Автоматическое удаление старых при превышении
-- ============================================

CREATE OR REPLACE FUNCTION limit_backups()
RETURNS TRIGGER AS $$
BEGIN
    DELETE FROM backups
    WHERE id IN (
        SELECT id FROM backups
        WHERE user_id = NEW.user_id
        ORDER BY created_at DESC
        OFFSET 50
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER backups_limit
    AFTER INSERT ON backups
    FOR EACH ROW
    EXECUTE FUNCTION limit_backups();
